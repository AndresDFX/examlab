import { describe, expect, it } from "vitest";
import { renderTemplate, buildSampleReportContext, SAMPLE_LOGO_DATA_URI } from "./template-engine";

describe("buildSampleReportContext", () => {
  it("rellena variables de muestra (estudiante, institución con logo)", () => {
    const ctx = buildSampleReportContext() as Record<string, any>;
    expect(ctx.estudiante.nombre).toBeTruthy();
    expect(ctx.institucion.logo).toBe(SAMPLE_LOGO_DATA_URI);
    // El preview puede renderizar variables sin que queden vacías.
    expect(renderTemplate("{{estudiante.nombre}} — {{nota_final}}", ctx)).toContain("—");
  });

  it("mezcla el override de institución conservando el logo de muestra", () => {
    const ctx = buildSampleReportContext({ institucion: { nombre: "Mi U" } }) as Record<string, any>;
    expect(ctx.institucion.nombre).toBe("Mi U");
    // No se pasó logo en el override → conserva el de muestra.
    expect(ctx.institucion.logo).toBe(SAMPLE_LOGO_DATA_URI);
  });

  it("el override puede fijar el logo real del tenant", () => {
    const ctx = buildSampleReportContext({
      institucion: { nombre: "Mi U", logo: "https://t.test/logo.png" },
    }) as Record<string, any>;
    expect(ctx.institucion.logo).toBe("https://t.test/logo.png");
  });
});

describe("renderTemplate — variables", () => {
  it("interpola variables simples", () => {
    expect(renderTemplate("Hola {{nombre}}", { nombre: "Ana" })).toBe("Hola Ana");
  });

  it("baja por paths con puntos", () => {
    expect(renderTemplate("{{user.name}}", { user: { name: "Bob" } })).toBe("Bob");
  });

  it("variables faltantes se renderean como vacío (no 'undefined')", () => {
    expect(renderTemplate("[{{missing}}]", {})).toBe("[]");
    expect(renderTemplate("[{{a.b.c}}]", { a: {} })).toBe("[]");
  });

  it("HTML-escapa por default (XSS)", () => {
    const out = renderTemplate("Hola {{name}}", { name: "<script>alert(1)</script>" });
    expect(out).toBe("Hola &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("triple-brace permite HTML crudo (escape hatch)", () => {
    const out = renderTemplate("{{{html}}}", { html: "<b>x</b>" });
    expect(out).toBe("<b>x</b>");
  });

  it("escapa comillas y ampersand", () => {
    const out = renderTemplate("{{x}}", { x: `a & "b" 'c'` });
    expect(out).toBe("a &amp; &quot;b&quot; &#39;c&#39;");
  });

  it("numbers y booleans se convierten a string", () => {
    expect(renderTemplate("{{n}} {{b}}", { n: 4.5, b: true })).toBe("4.5 true");
  });

  it("null/undefined → vacío", () => {
    expect(renderTemplate("[{{a}}][{{b}}]", { a: null, b: undefined })).toBe("[][]");
  });
});

describe("renderTemplate — {{#each}}", () => {
  it("itera sobre array de objetos", () => {
    const tpl = "{{#each items}}- {{name}}\n{{/each}}";
    const out = renderTemplate(tpl, {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    expect(out).toBe("- A\n- B\n- C\n");
  });

  it("expone @index (0-based) y @number (1-based)", () => {
    const tpl = "{{#each xs}}{{@number}}.{{name}} {{/each}}";
    const out = renderTemplate(tpl, { xs: [{ name: "A" }, { name: "B" }] });
    expect(out).toBe("1.A 2.B ");
  });

  it("array vacío no produce nada (no rompe)", () => {
    expect(renderTemplate("[{{#each xs}}x{{/each}}]", { xs: [] })).toBe("[]");
  });

  it("path no-array no itera (silencioso)", () => {
    expect(renderTemplate("[{{#each xs}}x{{/each}}]", { xs: null })).toBe("[]");
    expect(renderTemplate("[{{#each xs}}x{{/each}}]", { xs: "str" })).toBe("[]");
  });

  it("permite acceder al root desde dentro del each", () => {
    const tpl = "{{#each items}}{{name}}@{{curso}} {{/each}}";
    const out = renderTemplate(tpl, {
      curso: "Mat",
      items: [{ name: "A" }, { name: "B" }],
    });
    expect(out).toBe("A@Mat B@Mat ");
  });

  it("each anidado funciona y el scope interior gana", () => {
    const tpl =
      "{{#each cortes}}{{nombre}}: {{#each items}}{{titulo}}={{nota}} {{/each}}\n{{/each}}";
    const out = renderTemplate(tpl, {
      cortes: [
        { nombre: "C1", items: [{ titulo: "T1", nota: 5 }, { titulo: "T2", nota: 4 }] },
        { nombre: "C2", items: [{ titulo: "T3", nota: 3 }] },
      ],
    });
    expect(out).toBe("C1: T1=5 T2=4 \nC2: T3=3 \n");
  });

  it("each sobre primitivos: usa {{.}} para el valor", () => {
    expect(renderTemplate("{{#each xs}}[{{.}}]{{/each}}", { xs: ["a", "b", "c"] })).toBe(
      "[a][b][c]",
    );
  });
});

describe("renderTemplate — {{#if}}", () => {
  it("render hijos cuando truthy", () => {
    expect(renderTemplate("{{#if x}}ok{{/if}}", { x: true })).toBe("ok");
    expect(renderTemplate("{{#if x}}ok{{/if}}", { x: 1 })).toBe("ok");
    expect(renderTemplate("{{#if x}}ok{{/if}}", { x: "a" })).toBe("ok");
  });

  it("oculta cuando falsy", () => {
    expect(renderTemplate("[{{#if x}}ok{{/if}}]", { x: false })).toBe("[]");
    expect(renderTemplate("[{{#if x}}ok{{/if}}]", { x: 0 })).toBe("[]");
    expect(renderTemplate("[{{#if x}}ok{{/if}}]", { x: "" })).toBe("[]");
    expect(renderTemplate("[{{#if x}}ok{{/if}}]", { x: null })).toBe("[]");
    expect(renderTemplate("[{{#if x}}ok{{/if}}]", {})).toBe("[]");
  });

  it("array vacío es falsy (útil para 'sin items')", () => {
    expect(renderTemplate("{{#if xs}}sí{{/if}}", { xs: [] })).toBe("");
    expect(renderTemplate("{{#if xs}}sí{{/if}}", { xs: [1] })).toBe("sí");
  });

  it("if dentro de each accede al elemento", () => {
    const tpl = "{{#each xs}}{{#if activo}}{{name}} {{/if}}{{/each}}";
    const out = renderTemplate(tpl, {
      xs: [{ name: "A", activo: true }, { name: "B", activo: false }, { name: "C", activo: true }],
    });
    expect(out).toBe("A C ");
  });
});

describe("renderTemplate — robustez", () => {
  it("tira si un bloque no se cierra", () => {
    expect(() => renderTemplate("{{#each xs}}x", { xs: [1] })).toThrow();
  });

  it("texto sin tags pasa intacto", () => {
    expect(renderTemplate("hola mundo", {})).toBe("hola mundo");
    expect(renderTemplate("", {})).toBe("");
  });

  it("tags con espacios funcionan", () => {
    expect(renderTemplate("{{ name }}", { name: "x" })).toBe("x");
    expect(renderTemplate("{{#each  items  }}x{{/each}}", { items: [1, 2] })).toBe("xx");
  });

  it("multiples tags en la misma linea", () => {
    expect(renderTemplate("{{a}}-{{b}}-{{c}}", { a: 1, b: 2, c: 3 })).toBe("1-2-3");
  });
});

describe("renderTemplate — caso real (boletín)", () => {
  it("renderiza un boletín completo", () => {
    const tpl = `<h1>{{estudiante.nombre}}</h1>
{{#each cortes}}
  <h2>{{nombre}} ({{peso}}%)</h2>
  <p>Nota: {{nota}}</p>
{{/each}}
<p>Final: {{nota_final}}</p>`;
    const out = renderTemplate(tpl, {
      estudiante: { nombre: "Ana <Pérez>" },
      cortes: [
        { nombre: "Corte 1", peso: 30, nota: 4.2 },
        { nombre: "Corte 2", peso: 70, nota: 3.8 },
      ],
      nota_final: 3.92,
    });
    expect(out).toContain("Ana &lt;Pérez&gt;");
    expect(out).toContain("Corte 1 (30%)");
    expect(out).toContain("Final: 3.92");
  });
});
