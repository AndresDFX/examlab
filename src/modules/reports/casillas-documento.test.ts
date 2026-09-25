import { describe, it, expect } from "vitest";
import { fijarCasilla, leerCasilla } from "./casillas-documento";

const celda = (v: string) => `<td><p><span style="font-size:9pt">${v}</span></p></td>`;
/** El bloque del vocero tal como sale de la plantilla: pares rótulo/valor. */
const doc = (tel = "", ciudad = "") =>
  "<table><tbody>" +
  `<tr>${celda("Nombre del vocero")}${celda("")}</tr>` +
  `<tr>${celda("Teléfono")}${celda(tel)}${celda("E–mail")}${celda("")}</tr>` +
  `<tr>${celda("Ciudad")}${celda(ciudad)}${celda("Fecha")}${celda("04 de sept de 2026")}</tr>` +
  "</tbody></table>";

describe("leerCasilla", () => {
  it("lee el valor que sigue al rotulo", () => {
    expect(leerCasilla(doc("310 4055119"), "Teléfono")).toBe("310 4055119");
  });
  it("una casilla vacia se lee como cadena vacia, no como null", () => {
    // `null` significa «no existe ese rótulo»; vacío significa «existe y está
    // sin llenar». El caller decide distinto en cada caso.
    expect(leerCasilla(doc(), "Teléfono")).toBe("");
    expect(leerCasilla(doc(), "Rótulo inexistente")).toBeNull();
  });
  it("tolera null", () => {
    expect(leerCasilla(null, "Teléfono")).toBeNull();
  });
});

describe("fijarCasilla", () => {
  it("escribe en la casilla vacia que sigue al rotulo", () => {
    const out = fijarCasilla(doc(), "Teléfono", "310 4055119")!;
    expect(leerCasilla(out, "Teléfono")).toBe("310 4055119");
  });

  it("NO se corre a la fila de abajo cuando la casilla ya tiene valor", () => {
    // Este es el error que motivó el módulo: la primera versión buscaba «el
    // primer span VACÍO después del rótulo», así que al repetirla sobre un
    // documento ya corregido escribía el teléfono en la casilla de Ciudad.
    const out = fijarCasilla(doc("111"), "Teléfono", "999")!;
    expect(leerCasilla(out, "Teléfono")).toBe("999");
    expect(leerCasilla(out, "Ciudad")).toBe("");
  });

  it("es idempotente: escribir dos veces deja el mismo documento", () => {
    const una = fijarCasilla(doc(), "Teléfono", "310 4055119")!;
    const dos = fijarCasilla(una, "Teléfono", "310 4055119")!;
    expect(dos).toBe(una);
  });

  it("no toca las otras casillas", () => {
    const out = fijarCasilla(doc("", "Santiago de Cali"), "E–mail", "a@b.edu")!;
    expect(leerCasilla(out, "E–mail")).toBe("a@b.edu");
    expect(leerCasilla(out, "Ciudad")).toBe("Santiago de Cali");
    expect(leerCasilla(out, "Fecha")).toBe("04 de sept de 2026");
  });

  it("llena el nombre del vocero, que no tiene rotulo en su propia fila", () => {
    const out = fijarCasilla(doc(), "Nombre del vocero", "Rosero Silva Jhoan Sebastian")!;
    expect(leerCasilla(out, "Nombre del vocero")).toBe("Rosero Silva Jhoan Sebastian");
  });

  it("escapa el HTML del valor", () => {
    // Un nombre con `<` rompería la tabla del documento.
    const out = fijarCasilla(doc(), "Teléfono", "a<b>c")!;
    expect(out).toContain("a&lt;b&gt;c");
    expect(out).not.toContain("<b>c");
  });

  it("un valor vacio NO borra lo que habia", () => {
    // Borrar un dato de un documento firmado tiene que ser explícito, nunca el
    // efecto de pasar un `undefined`.
    expect(fijarCasilla(doc("111"), "Teléfono", "")).toBeNull();
    expect(fijarCasilla(doc("111"), "Teléfono", null)).toBeNull();
    expect(fijarCasilla(doc("111"), "Teléfono", undefined)).toBeNull();
  });

  it("devuelve null si el rotulo no esta, en vez de escribir en otro lado", () => {
    expect(fijarCasilla(doc(), "Documento", "123")).toBeNull();
  });

  it("tolera null", () => {
    expect(fijarCasilla(null, "Teléfono", "1")).toBeNull();
  });
});
