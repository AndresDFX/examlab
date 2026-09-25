import { describe, it, expect } from "vitest";
import { refrescarDatos, refrescarFila } from "./refrescar-datos";
import { ranuraHtml } from "./signature-slots";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const celda = (v: string) => `<td style="padding:4px"><span style="font-size:9pt">${v}</span></td>`;
/** Una fila del listado: nº · nombre · documento · firma. */
const fila = (n: number, nombre: string, doc: string, uid: string) =>
  `<tr>${celda(String(n))}${celda(nombre)}${celda(doc)}<td>${ranuraHtml(uid)}</td></tr>`;

describe("refrescarFila", () => {
  it("actualiza el nombre incompleto", () => {
    // El caso real: alumnos registrados como «Josuan» o «Js Cadavid».
    const out = refrescarFila(fila(4, "Josuan", "", A), { nombre: "Beltran Castaño Josuhan David" });
    expect(out).toContain("Beltran Castaño Josuhan David");
    expect(out).not.toContain(">Josuan<");
  });

  it("llena el documento que faltaba", () => {
    const out = refrescarFila(fila(4, "Ana", "", A), { documento: "1110368229" });
    expect(out).toContain("1110368229");
  });

  it("actualiza nombre y documento a la vez, cada uno en SU celda", () => {
    const out = refrescarFila(fila(4, "Js Cadavid", "", A), {
      nombre: "Cadavid Urrea John Sebastian",
      documento: "1005979885",
    });
    // El nombre antes que el documento, que es el orden de las columnas.
    expect(out.indexOf("Cadavid Urrea John Sebastian")).toBeLessThan(out.indexOf("1005979885"));
    // Y el número de orden no se movió.
    expect(out.indexOf(">4<")).toBeLessThan(out.indexOf("Cadavid"));
  });

  it("NO toca la celda de la firma", () => {
    // Una firma ya puesta se dibuja dentro de esa ranura: tocarla la borraría.
    const original = fila(4, "Ana", "111", A);
    const out = refrescarFila(original, { nombre: "Ana María", documento: "222" });
    expect(out).toContain(`data-firma-uid="${A}"`);
    const ranuras = (out.match(/data-firma-uid/g) || []).length;
    expect(ranuras).toBe(1);
  });

  it("un valor vacio NO borra lo que habia", () => {
    const out = refrescarFila(fila(4, "Ana", "111", A), { nombre: "", documento: null });
    expect(out).toContain(">Ana<");
    expect(out).toContain(">111<");
  });

  it("una fila SIN firma se devuelve intacta", () => {
    // No es de un firmante: puede ser un encabezado o una fila de totales.
    const otra = `<tr>${celda("Total")}${celda("33")}</tr>`;
    expect(refrescarFila(otra, { nombre: "X" })).toBe(otra);
  });

  it("una fila con forma inesperada se devuelve intacta, no se adivina", () => {
    const rara = `<tr><td>${ranuraHtml(A)}</td></tr>`;
    expect(refrescarFila(rara, { nombre: "X" })).toBe(rara);
  });

  it("con solo dos celdas antes de la firma, actualiza el nombre y nada mas", () => {
    const corta = `<tr>${celda("1")}${celda("Ana")}<td>${ranuraHtml(A)}</td></tr>`;
    const out = refrescarFila(corta, { nombre: "Ana María", documento: "999" });
    expect(out).toContain("Ana María");
    expect(out).not.toContain("999");
  });

  it("escapa el HTML del valor", () => {
    const out = refrescarFila(fila(1, "x", "", A), { nombre: "a<b>c" });
    expect(out).toContain("a&lt;b&gt;c");
  });
});

describe("refrescarDatos", () => {
  const doc =
    `<table><tbody>${fila(1, "Josuan", "", A)}${fila(2, "Beto", "222", B)}</tbody></table>` +
    `<table><tbody><tr>${celda("El Docente")}<td>${ranuraHtml("cccccccc-cccc-cccc-cccc-cccccccccccc")}</td></tr></tbody></table>`;

  it("actualiza solo las filas cuyo uid esta en el mapa", () => {
    const { html, filasTocadas } = refrescarDatos(
      doc,
      new Map([[A, { nombre: "Beltran Castaño Josuhan David", documento: "111" }]]),
    );
    expect(filasTocadas).toBe(1);
    expect(html).toContain("Beltran Castaño Josuhan David");
    expect(html).toContain(">Beto<"); // la otra fila, intacta
  });

  it("un uid ausente del mapa deja su fila como estaba", () => {
    // Preferible un dato viejo a uno borrado.
    const { html, filasTocadas } = refrescarDatos(doc, new Map());
    expect(filasTocadas).toBe(0);
    expect(html).toBe(doc);
  });

  it("conserva TODAS las ranuras, incluida la del bloque de firmas", () => {
    const { html } = refrescarDatos(doc, new Map([[A, { nombre: "X" }]]));
    const antes = new Set([...doc.matchAll(/data-firma-uid="([^"]*)"/g)].map((m) => m[1]));
    const desp = new Set([...html.matchAll(/data-firma-uid="([^"]*)"/g)].map((m) => m[1]));
    expect(desp).toEqual(antes);
  });

  it("es idempotente", () => {
    const mapa = new Map([[A, { nombre: "Nombre Nuevo", documento: "111" }]]);
    const una = refrescarDatos(doc, mapa).html;
    const dos = refrescarDatos(una, mapa);
    expect(dos.html).toBe(una);
    expect(dos.filasTocadas).toBe(0);
  });

  it("tolera null", () => {
    expect(refrescarDatos(null, new Map())).toEqual({ html: "", filasTocadas: 0 });
  });
});
