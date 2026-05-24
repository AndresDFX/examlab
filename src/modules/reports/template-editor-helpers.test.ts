import { describe, expect, it } from "vitest";
import { composeTemplateHtml, draftEqual, emptyDraft } from "./TemplateEditor";

describe("emptyDraft", () => {
  it("retorna un draft con todos los campos string vacíos", () => {
    const d = emptyDraft();
    expect(d.name).toBe("");
    expect(d.description).toBe("");
    expect(d.body_html).toBe("");
    expect(d.header_html).toBe("");
    expect(d.footer_html).toBe("");
    expect(d.css).toBe("");
  });

  it("scope default = 'estudiante' (más común que 'curso')", () => {
    expect(emptyDraft().scope).toBe("estudiante");
  });

  it("page defaults: A4 vertical (lo común en LATAM)", () => {
    const d = emptyDraft();
    expect(d.page_orientation).toBe("portrait");
    expect(d.page_size).toBe("A4");
  });

  it("dos llamadas devuelven objetos distintos (no aliasing)", () => {
    // Si emptyDraft devolviera siempre el mismo objeto, modificar el draft
    // del editor mutaría también el "original" usado para detectar cambios.
    const a = emptyDraft();
    const b = emptyDraft();
    expect(a).not.toBe(b);
    a.name = "modificado";
    expect(b.name).toBe(""); // b NO se ve afectado
  });
});

describe("draftEqual", () => {
  it("dos emptyDraft() son iguales", () => {
    expect(draftEqual(emptyDraft(), emptyDraft())).toBe(true);
  });

  it("detecta cambio en cada campo individualmente", () => {
    const base = emptyDraft();
    expect(draftEqual(base, { ...base, name: "x" })).toBe(false);
    expect(draftEqual(base, { ...base, description: "x" })).toBe(false);
    expect(draftEqual(base, { ...base, scope: "curso" })).toBe(false);
    expect(draftEqual(base, { ...base, body_html: "x" })).toBe(false);
    expect(draftEqual(base, { ...base, header_html: "x" })).toBe(false);
    expect(draftEqual(base, { ...base, footer_html: "x" })).toBe(false);
    expect(draftEqual(base, { ...base, css: "x" })).toBe(false);
    expect(draftEqual(base, { ...base, page_orientation: "landscape" })).toBe(false);
    expect(draftEqual(base, { ...base, page_size: "letter" })).toBe(false);
  });

  it("acepta drafts con el mismo contenido pero referencias distintas", () => {
    const a = { ...emptyDraft(), name: "Boletín" };
    const b = { ...emptyDraft(), name: "Boletín" };
    expect(a).not.toBe(b);
    expect(draftEqual(a, b)).toBe(true);
  });
});

describe("composeTemplateHtml", () => {
  const baseDraft = {
    body_html: "<h1>Hola</h1>",
    header_html: "",
    footer_html: "",
    css: "",
    page_orientation: "portrait" as const,
    page_size: "A4" as const,
  };

  it("devuelve un documento HTML válido (doctype + html + body)", () => {
    const out = composeTemplateHtml(baseDraft);
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toContain("<html>");
    expect(out).toContain("<body>");
    expect(out).toContain("</body></html>");
  });

  it("incluye el body_html dentro de <main>", () => {
    const out = composeTemplateHtml({ ...baseDraft, body_html: "<p>contenido</p>" });
    expect(out).toContain("<main><p>contenido</p></main>");
  });

  it("incluye <header> solo cuando header_html no está vacío", () => {
    const con = composeTemplateHtml({ ...baseDraft, header_html: "<h1>HDR</h1>" });
    expect(con).toContain("<header><h1>HDR</h1></header>");
    const sin = composeTemplateHtml(baseDraft);
    expect(sin).not.toContain("<header>");
  });

  it("incluye <footer> solo cuando footer_html no está vacío", () => {
    const con = composeTemplateHtml({ ...baseDraft, footer_html: "Pie" });
    expect(con).toContain("<footer>Pie</footer>");
    const sin = composeTemplateHtml(baseDraft);
    expect(sin).not.toContain("<footer>");
  });

  it("@page declara size + orientation desde page_size/orientation", () => {
    const portrait = composeTemplateHtml({ ...baseDraft, page_size: "A4", page_orientation: "portrait" });
    expect(portrait).toContain("@page { size: A4 portrait;");

    const landscape = composeTemplateHtml({
      ...baseDraft,
      page_size: "letter",
      page_orientation: "landscape",
    });
    expect(landscape).toContain("@page { size: letter landscape;");
  });

  it("inyecta el CSS del docente dentro del <style>", () => {
    const out = composeTemplateHtml({
      ...baseDraft,
      css: "h1 { color: red; }",
    });
    expect(out).toContain("h1 { color: red; }");
    // Debe estar DENTRO de <style>, no en otro lado.
    const styleBlock = out.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(styleBlock).toContain("h1 { color: red; }");
  });

  it("CSS vacío no rompe la composición", () => {
    const out = composeTemplateHtml(baseDraft);
    expect(out).toContain("<style>");
    expect(out).toContain("</style>");
  });

  it("acepta null/undefined en css sin tirar", () => {
    // Defensivo: el draft viene de la DB; css puede ser null/undefined.
    const out = composeTemplateHtml({
      ...baseDraft,
      // @ts-expect-error simulando valor real de DB con null
      css: null,
    });
    expect(out).toContain("<style>");
  });
});
