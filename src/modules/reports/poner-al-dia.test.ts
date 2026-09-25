import { describe, it, expect } from "vitest";
import { fijarRanuraDeVocero, ordenarListado } from "./poner-al-dia";
import { ranuraHtml, renglonManualHtml, uidsDeRanuras } from "./signature-slots";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DOC = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const VOC = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const celda = (v: string) => `<td style="p"><span style="s">${v}</span></td>`;
const filaEst = (n: number, nombre: string, uid: string) =>
  `<tr>${celda(String(n))}${celda(nombre)}${celda("")}<td>${ranuraHtml(uid)}</td></tr>`;

/** El bloque de firmas: una fila con las casillas y otra con los rótulos. */
const bloqueFirmas = (celdaVocero: string) =>
  "<table><tbody>" +
  `<tr><td>${ranuraHtml(DOC)}</td><td>${celdaVocero}</td><td>&nbsp;</td></tr>` +
  `<tr>${celda("El Docente / Tutor")}${celda("El Vocero")}${celda("Director")}</tr>` +
  "</tbody></table>";

describe("fijarRanuraDeVocero", () => {
  it("reemplaza el renglon manual por la casilla del vocero", () => {
    // El caso real: al generar el documento el curso no tenía vocero, así que
    // quedó un renglón para firmar a mano y la firma no tiene dónde dibujarse.
    const html = bloqueFirmas(renglonManualHtml());
    const out = fijarRanuraDeVocero(html, VOC)!;
    expect(out).not.toBeNull();
    expect(uidsDeRanuras(out)).toContain(VOC);
    expect(out).not.toContain("examlab-renglon");
  });

  it("la casilla del docente queda intacta", () => {
    const out = fijarRanuraDeVocero(bloqueFirmas(renglonManualHtml()), VOC)!;
    expect(uidsDeRanuras(out)).toEqual(expect.arrayContaining([DOC, VOC]));
  });

  it("ubica el recuadro por su COLUMNA, no por una posicion fija", () => {
    // El bloque tiene tres columnas; otra plantilla podría ordenarlas distinto.
    const html =
      "<table><tbody>" +
      `<tr><td>${renglonManualHtml()}</td><td>${ranuraHtml(DOC)}</td></tr>` +
      `<tr>${celda("El Vocero")}${celda("El Docente / Tutor")}</tr>` +
      "</tbody></table>";
    const out = fijarRanuraDeVocero(html, VOC)!;
    // La casilla nueva va en la PRIMERA columna, que es la del rótulo.
    expect(out.indexOf(VOC)).toBeLessThan(out.indexOf(DOC));
  });

  it("no hace nada si el recuadro YA tiene casilla", () => {
    // Idempotente: volver a correrlo no duplica ni pisa la firma existente.
    expect(fijarRanuraDeVocero(bloqueFirmas(ranuraHtml(VOC)), VOC)).toBeNull();
  });

  it("devuelve null sin vocero, sin rotulo, o con html vacio", () => {
    expect(fijarRanuraDeVocero(bloqueFirmas(renglonManualHtml()), null)).toBeNull();
    expect(fijarRanuraDeVocero("<p>nada</p>", VOC)).toBeNull();
    expect(fijarRanuraDeVocero(null, VOC)).toBeNull();
  });
});

describe("ordenarListado", () => {
  const listado = (filas: string) => `<table><tbody>${filas}</tbody></table>`;
  // Guardado con los nombres VIEJOS, que es como quedó el orden original.
  const doc = listado(filaEst(1, "Zaz", A) + filaEst(2, "Ana", B) + filaEst(3, "Bea", C));

  it("reordena segun el orden dado y renumera", () => {
    const orden = new Map([
      [B, 0],
      [C, 1],
      [A, 2],
    ]);
    const { html, reordenado } = ordenarListado(doc, orden);
    expect(reordenado).toBe(true);
    // Ana, Bea, Zaz — y numeradas 1, 2, 3.
    expect(html.indexOf("Ana")).toBeLessThan(html.indexOf("Bea"));
    expect(html.indexOf("Bea")).toBeLessThan(html.indexOf("Zaz"));
    const nums = [...html.matchAll(/<span style="s">(\d+)<\/span>/g)].map((m) => m[1]);
    expect(nums).toEqual(["1", "2", "3"]);
  });

  it("NO pierde ninguna casilla al reordenar", () => {
    // Se mueven filas enteras, con su casilla adentro.
    const { html } = ordenarListado(doc, new Map([[B, 0], [C, 1], [A, 2]]));
    expect(new Set(uidsDeRanuras(html))).toEqual(new Set([A, B, C]));
  });

  it("un uid que no esta en el mapa va al final, conservando su orden", () => {
    // Preferible una fila fuera de lugar a una fila perdida.
    const { html } = ordenarListado(doc, new Map([[C, 0]]));
    expect(html.indexOf("Bea")).toBeLessThan(html.indexOf("Zaz"));
    expect(html.indexOf("Zaz")).toBeLessThan(html.indexOf("Ana"));
  });

  it("es idempotente", () => {
    const orden = new Map([[B, 0], [C, 1], [A, 2]]);
    const una = ordenarListado(doc, orden).html;
    const dos = ordenarListado(una, orden);
    expect(dos.html).toBe(una);
    expect(dos.reordenado).toBe(false);
  });

  it("si las filas de firmantes NO son contiguas, no reacomoda nada", () => {
    // Con un subtotal en el medio, mover filas cambiaría el significado de la
    // tabla. Se prefiere dejarla como está.
    const conSubtotal = listado(
      filaEst(1, "Zaz", A) + `<tr>${celda("Subtotal")}</tr>` + filaEst(2, "Ana", B),
    );
    const { reordenado } = ordenarListado(conSubtotal, new Map([[B, 0], [A, 1]]));
    expect(reordenado).toBe(false);
  });

  it("con una sola fila no hay nada que ordenar", () => {
    const { reordenado } = ordenarListado(listado(filaEst(1, "Ana", A)), new Map([[A, 0]]));
    expect(reordenado).toBe(false);
  });

  it("tolera null", () => {
    expect(ordenarListado(null, new Map())).toEqual({ html: "", reordenado: false });
  });
});
