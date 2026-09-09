import { describe, expect, it } from "vitest";

import { conEstilosDeDocumento, cssCorteEnCeldas, cssLienzoBlanco } from "./document-css";

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

describe("cssLienzoBlanco", () => {
  it("pinta el lienzo de blanco en html y en body", () => {
    // `background-color` es lo único que arregla el negro-sobre-negro: sin fondo
    // el lienzo queda transparente y se ve el `--card` oscuro del padre.
    expect(cssLienzoBlanco()).toBe(
      "html { color-scheme: light; background-color: #fff; } body { background-color: #fff; }",
    );
  });

  it("fija color-scheme claro", () => {
    // No arregla el lienzo por sí solo (medido); es el cerrojo para los colores
    // de sistema de adentro y para si la app declara color-scheme: dark.
    expect(cssLienzoBlanco()).toContain("color-scheme: light");
  });

  it("NO fuerza el color del texto", () => {
    // Forzar `color:#000` aplanaría los colores del formato (el azul
    // institucional que hereda del .docx).
    const sinLosNuestros = cssLienzoBlanco()
      .replaceAll("background-color", "")
      .replaceAll("color-scheme", "");
    expect(sinLosNuestros).not.toContain("color:");
  });

  it("es un piso, no una imposición: sin !important", () => {
    // Se inyecta ANTES del <style> del documento, y el css de la plantilla va
    // último: el formato tiene que poder sobreescribirlo.
    expect(cssLienzoBlanco()).not.toContain("!important");
  });

  it("el lienzo NO se cuela en la regla prefijable de celdas", () => {
    // `cssCorteEnCeldas` se llama con `.examlab-page` en la vista previa
    // paginada: un `.examlab-page html {…}` no matchea nada, y el escritorio
    // gris de esa previa es deliberado.
    expect(cssCorteEnCeldas()).toBe("td, th { overflow-wrap: anywhere; }");
    expect(cssCorteEnCeldas()).not.toContain("background");
    expect(cssCorteEnCeldas(".examlab-page")).not.toContain("html");
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

  it("el snapshot guardado recibe el lienzo blanco al MOSTRARLO", () => {
    const r = conEstilosDeDocumento(doc("<table><tr><td>x</td></tr></table>"));
    expect(r).toContain("background-color: #fff");
    expect(r).toContain("color-scheme: light");
  });

  it("el lienzo va DENTRO del head, no antes del doctype", () => {
    // Antes del doctype = quirks mode = cambia el modelo de caja de las tablas.
    const r = conEstilosDeDocumento(doc("<p>hola</p>"));
    expect(r.indexOf("<!doctype html>")).toBe(0);
    const i = r.indexOf("background-color: #fff");
    expect(i).toBeGreaterThan(r.indexOf("<head>"));
    expect(i).toBeLessThan(r.indexOf("</head>"));
  });

  it("idempotente también para el lienzo: dos pasadas no lo duplican", () => {
    const una = conEstilosDeDocumento(doc("<p>x</p>"));
    const dos = conEstilosDeDocumento(una);
    expect(dos).toBe(una);
    expect(dos.match(/color-scheme: light/g)).toHaveLength(1);
  });

  it("un html vacío se devuelve tal cual", () => {
    expect(conEstilosDeDocumento("")).toBe("");
  });
});
