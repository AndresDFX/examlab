import { describe, it, expect } from "vitest";
import { insertarEnListado, tablaDelListado } from "./insertar-filas";
import { ranuraHtml } from "./signature-slots";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const fila = (uid: string, nombre: string) => `<tr><td>${nombre}</td><td>${ranuraHtml(uid)}</td></tr>`;

/** Un Acuerdo en miniatura: listado de estudiantes + bloque de firmas. */
const doc = (extra = "") =>
  `<h1>Acuerdo</h1>` +
  `<table><tbody>${fila(A, "Ana")}${fila(B, "Beto")}${fila(C, "Caro")}${extra}</tbody></table>` +
  `<p>Firmas</p>` +
  `<table><tbody><tr><td>El Docente</td><td>${ranuraHtml(D)}</td></tr></tbody></table>`;

describe("tablaDelListado", () => {
  it("elige la tabla con MAS ranuras, no la primera ni la ultima", () => {
    // El bloque de firmas también tiene ranuras; si se tomara por posición, las
    // filas nuevas caerían entre las firmas del docente y el vocero.
    const t = tablaDelListado(doc());
    expect(t).not.toBeNull();
    expect(t!.filasConRanura).toBe(3);
  });

  it("devuelve null si ninguna tabla tiene ranuras", () => {
    expect(tablaDelListado("<table><tbody><tr><td>x</td></tr></tbody></table>")).toBeNull();
  });

  it("tolera null y vacio", () => {
    expect(tablaDelListado(null)).toBeNull();
    expect(tablaDelListado("")).toBeNull();
  });

  it("no se confunde con una tabla ANIDADA", () => {
    // El HTML de estas plantillas viene de un .docx y anida tablas seguido: sin
    // contar profundidad, el primer </table> cerraria la de afuera.
    const anidado =
      `<table><tbody><tr><td><table><tbody><tr><td>x</td></tr></tbody></table></td></tr>` +
      `${fila(A, "Ana")}${fila(B, "Beto")}</tbody></table>`;
    expect(tablaDelListado(anidado)!.filasConRanura).toBe(2);
  });
});

describe("insertarEnListado", () => {
  it("agrega la fila DENTRO del listado, no en una tabla aparte", () => {
    const out = insertarEnListado(doc(), fila(D, "Dani"))!;
    expect(out).not.toBeNull();
    // Una sola tabla de listado: no se creó ninguna nueva.
    expect((out.match(/<table/g) || []).length).toBe(2);
    // Y la fila nueva quedó antes del cierre del cuerpo del listado.
    const listado = out.slice(0, out.indexOf("<p>Firmas</p>"));
    expect(listado).toContain("Dani");
  });

  it("la fila nueva va DESPUES de las que ya estaban", () => {
    const out = insertarEnListado(doc(), fila(D, "Dani"))!;
    expect(out.indexOf("Dani")).toBeGreaterThan(out.indexOf("Caro"));
  });

  it("se inserta dentro del tbody, no despues", () => {
    // Word no tolera filas fuera del <tbody>; los navegadores sí, así que el
    // error no se vería hasta descargar el Word.
    const out = insertarEnListado(doc(), fila(D, "Dani"))!;
    expect(out.indexOf("Dani")).toBeLessThan(out.indexOf("</tbody>"));
  });

  it("funciona en una tabla SIN tbody explicito", () => {
    const sinTbody = `<table>${fila(A, "Ana")}${fila(B, "Beto")}</table>`;
    const out = insertarEnListado(sinTbody, fila(C, "Caro"))!;
    expect(out).toContain("Caro");
    expect(out.indexOf("Caro")).toBeLessThan(out.indexOf("</table>"));
  });

  it("NO inserta a ciegas si no hay donde: devuelve null", () => {
    // Escribir en el lugar equivocado de un documento firmado es peor que no
    // escribir.
    expect(insertarEnListado("<p>sin tablas</p>", fila(A, "Ana"))).toBeNull();
  });

  it("no hace nada con filas vacias", () => {
    expect(insertarEnListado(doc(), "   ")).toBeNull();
  });

  it("acepta varias filas de una", () => {
    const out = insertarEnListado(doc(), fila(D, "Dani") + fila("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "Eli"))!;
    expect(out).toContain("Dani");
    expect(out).toContain("Eli");
    expect((out.match(/<table/g) || []).length).toBe(2);
  });
});
