import { describe, it, expect } from "vitest";
import { conservaLasRanuras, ranurasPerdidas } from "./editar-html";
import { ranuraHtml, renglonManualHtml } from "./signature-slots";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const doc = (uids: string[], texto = "Acuerdo") =>
  `<h1>${texto}</h1><table><tr>${uids.map((u) => `<td>${ranuraHtml(u)}</td>`).join("")}</tr></table>`;

describe("ranurasPerdidas", () => {
  it("editar SOLO el texto no pierde ninguna ranura", () => {
    // El caso que motiva la funcionalidad: corregir un nombre mal escrito.
    expect(ranurasPerdidas(doc([A, B], "Josuan"), doc([A, B], "Josuhan"))).toEqual([]);
  });

  it("detecta a quien se quedo sin ranura", () => {
    expect(ranurasPerdidas(doc([A, B, C]), doc([A, C]))).toEqual([B]);
  });

  it("reordenar no cuenta como perdida", () => {
    // Cortar y pegar una fila cambia el orden sin sacar a nadie; se compara
    // por uid justamente para que eso siga siendo legal.
    expect(ranurasPerdidas(doc([A, B, C]), doc([C, A, B]))).toEqual([]);
  });

  it("agregar firmantes es legal", () => {
    expect(ranurasPerdidas(doc([A]), doc([A, B]))).toEqual([]);
  });

  it("vaciar el documento reporta TODAS las perdidas", () => {
    expect(ranurasPerdidas(doc([A, B]), "<p>vacio</p>")).toEqual([A, B]);
  });

  it("un renglon para firmar a mano no es una ranura anclada", () => {
    // No tiene uid: no hay firma digital que pueda quedar huérfana.
    expect(ranurasPerdidas(renglonManualHtml(), "<p>nada</p>")).toEqual([]);
  });

  it("un documento sin ranuras se puede editar libremente", () => {
    expect(ranurasPerdidas("<p>hola</p>", "<p>chau</p>")).toEqual([]);
  });

  it("tolera null y undefined", () => {
    expect(ranurasPerdidas(null, undefined)).toEqual([]);
    expect(ranurasPerdidas(doc([A]), null)).toEqual([A]);
  });
});

describe("conservaLasRanuras", () => {
  it("es true cuando no se perdio nada", () => {
    expect(conservaLasRanuras(doc([A, B], "antes"), doc([A, B], "despues"))).toBe(true);
  });
  it("es false apenas falta una", () => {
    expect(conservaLasRanuras(doc([A, B]), doc([A]))).toBe(false);
  });
});
