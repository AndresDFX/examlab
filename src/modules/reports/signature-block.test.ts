import { describe, expect, it } from "vitest";
import { signatureTableHtml } from "./signature-block";
import { renderTemplate } from "./template-engine";

const CONTEXTO = {
  docente: { nombre: "Julián Castaño" },
  fecha_emision: "24 ago 2026",
  estudiantes: [
    { nombre: "Ana María Gómez", codigo: "202112345", documento: "1144194156" },
    { nombre: "Julián Restrepo", codigo: "202154321", documento: "1098765432" },
    { nombre: "Camila Ospina", codigo: "202199999", documento: "1012345678" },
  ],
};

/** Texto visible, para afirmar sobre lo que se IMPRIME y no sobre el markup. */
const plano = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("signatureTableHtml", () => {
  it("genera una fila por estudiante matriculado, no un número fijo", () => {
    // El formato institucional traía 22 filas vacías numeradas a mano: con 31
    // matriculados, nueve firmaban al margen; con 12, sobraban diez renglones.
    const salida = renderTemplate(signatureTableHtml(), CONTEXTO);
    const t = plano(salida);
    expect(t).toContain("1 Ana María Gómez 202112345");
    expect(t).toContain("2 Julián Restrepo 202154321");
    expect(t).toContain("3 Camila Ospina 202199999");
    expect(salida.match(/202\d{6}/g)).toHaveLength(3);
  });

  it("con un curso vacío no deja filas fantasma", () => {
    const salida = renderTemplate(signatureTableHtml(), { ...CONTEXTO, estudiantes: [] });
    expect(salida).not.toMatch(/202\d{6}/);
    expect(salida).toContain("Estudiante"); // la cabecera sí queda
  });

  it("numera desde 1, no desde 0", () => {
    const t = plano(renderTemplate(signatureTableHtml(), CONTEXTO));
    expect(t).toContain("1 Ana");
    expect(t).not.toContain("0 Ana");
  });

  it("no deja variables sin resolver", () => {
    const salida = renderTemplate(signatureTableHtml(), CONTEXTO);
    expect(salida).not.toContain("{{");
  });

  it("la celda de firma tiene alto propio: si no, no hay dónde firmar", () => {
    expect(signatureTableHtml()).toContain("height:30px");
  });

  it("el pie del docente sale con su nombre y la fecha", () => {
    const t = plano(renderTemplate(signatureTableHtml(), CONTEXTO));
    expect(t).toContain("Docente: Julián Castaño");
    expect(t).toContain("Fecha: 24 ago 2026");
  });

  it("se puede apagar el pie del docente", () => {
    const salida = signatureTableHtml({ incluirDocente: false });
    expect(salida).not.toContain("docente.nombre");
  });

  it("la columna de documento es opcional y no está por defecto", () => {
    expect(signatureTableHtml()).not.toContain("{{documento}}");
    expect(signatureTableHtml({ incluirDocumento: true })).toContain("{{documento}}");
  });

  it("los anchos de columna suman 100%", () => {
    for (const op of [
      {},
      { incluirCodigo: false },
      { incluirDocumento: true },
      { incluirCodigo: false, incluirDocumento: true },
    ]) {
      const html = signatureTableHtml(op);
      // solo la PRIMERA tabla (la de firmas); la del docente usa 50/50
      const primera = html.slice(0, html.indexOf("{{#each"));
      // solo los anchos de CELDA: el <table> declara su propio width:100% y
      // contarlo daba 200 (el fallo original de este test, no del código).
      const anchos = [...primera.matchAll(/<td style="[^"]*width:(\d+)%/g)].map((m) =>
        Number(m[1]),
      );
      const suma = anchos.reduce((a, b) => a + b, 0);
      expect(suma, `anchos ${JSON.stringify(anchos)} con ${JSON.stringify(op)}`).toBe(100);
    }
  });

  it("un título vacío no imprime un encabezado en blanco", () => {
    expect(signatureTableHtml({ titulo: "" })).not.toContain("<strong></strong>");
  });
});
