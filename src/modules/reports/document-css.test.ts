import { describe, expect, it } from "vitest";

import { conEstilosDeDocumento, cssCorteEnCeldas } from "./document-css";

describe("cssCorteEnCeldas", () => {
  it("sin prefijo, la regla aplica a las celdas del documento", () => {
    expect(cssCorteEnCeldas()).toBe("td, th { overflow-wrap: anywhere; }");
  });

  it("con prefijo, queda scopeada a la hoja de la vista previa", () => {
    // La vista previa paginada scopea TODO por `.examlab-page`; una regla pelada
    // ahí no aplicaría.
    expect(cssCorteEnCeldas(".examlab-page")).toBe(
      ".examlab-page td, .examlab-page th { overflow-wrap: anywhere; }",
    );
  });

  it("usa `anywhere` y NO `break-all`", () => {
    // `break-all` partiría también las palabras normales del acta.
    expect(cssCorteEnCeldas()).toContain("anywhere");
    expect(cssCorteEnCeldas()).not.toContain("break-all");
  });
});

describe("conEstilosDeDocumento", () => {
  const doc = (cuerpo: string) =>
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${cuerpo}</body></html>`;

  it("mete el estilo DENTRO del head, no antes del doctype", () => {
    // Antes del doctype el navegador entra en quirks mode y cambia el modelo de
    // caja de las tablas — justo lo que estamos arreglando.
    const r = conEstilosDeDocumento(doc("<p>hola</p>"));
    expect(r.indexOf("<!doctype html>")).toBe(0);
    expect(r.indexOf("<style")).toBeGreaterThan(r.indexOf("<head>"));
    expect(r.indexOf("<style")).toBeLessThan(r.indexOf("</head>"));
  });

  it("no toca el contenido del documento", () => {
    const cuerpo = '<table><tr><td>kabarona@estudiante.uniajc.edu.co</td></tr></table>';
    expect(conEstilosDeDocumento(doc(cuerpo))).toContain(cuerpo);
  });

  it("es idempotente: dos pasadas no duplican el estilo", () => {
    const una = conEstilosDeDocumento(doc("<p>x</p>"));
    const dos = conEstilosDeDocumento(una);
    expect(dos).toBe(una);
    expect(dos.match(/overflow-wrap/g)).toHaveLength(1);
  });

  it("un fragmento sin head recibe el estilo antepuesto", () => {
    const r = conEstilosDeDocumento("<table><tr><td>a</td></tr></table>");
    expect(r.startsWith("<style")).toBe(true);
    expect(r).toContain("<table>");
  });

  it("con <html> pero sin <head>, lo crea en lugar de anteponer", () => {
    const r = conEstilosDeDocumento("<html><body><p>a</p></body></html>");
    expect(r.startsWith("<html>")).toBe(true);
    expect(r).toContain("<head><style");
  });

  it("un html vacío se devuelve tal cual", () => {
    expect(conEstilosDeDocumento("")).toBe("");
  });
});
