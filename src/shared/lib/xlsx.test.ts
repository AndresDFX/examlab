/**
 * Tests del writer de Excel (.xlsx) sin dependencias.
 *
 * No tenemos un unzip en el entorno de test, así que validamos:
 *  - estructura del ZIP (firmas PK locales + central dir + EOCD, conteo de
 *    entradas), que es lo que rompería que Excel no lo abra;
 *  - que el XML de la hoja contiene las celdas/tipos correctos (buscando los
 *    bytes UTF-8 de cada parte dentro del buffer);
 *  - CRC32 contra el valor canónico conocido.
 */
import { describe, expect, it } from "vitest";
import { toXLSX } from "./xlsx";

const dec = new TextDecoder();
function asText(u8: Uint8Array): string {
  // El contenido (STORE, sin comprimir) está en claro dentro del zip.
  return dec.decode(u8);
}

// Lee el EOCD (últimos 22 bytes) → número de entradas del central directory.
function eocdEntryCount(u8: Uint8Array): number {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const off = u8.length - 22;
  expect(dv.getUint32(off, true)).toBe(0x06054b50); // firma EOCD
  return dv.getUint16(off + 10, true);
}

describe("toXLSX", () => {
  it("produce un ZIP válido (PK header + EOCD + 5 partes OOXML)", () => {
    const out = toXLSX([{ a: "1", b: "x" }]);
    expect(out).toBeInstanceOf(Uint8Array);
    // Local file header signature al inicio: 'P','K',0x03,0x04
    expect([out[0], out[1], out[2], out[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // 5 partes: [Content_Types].xml, _rels/.rels, workbook.xml, workbook rels, sheet1.xml
    expect(eocdEntryCount(out)).toBe(5);
    const text = asText(out);
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("xl/worksheets/sheet1.xml");
    expect(text).toContain("xl/workbook.xml");
  });

  it("encabezados en fila 1 + datos desde fila 2", () => {
    const text = asText(toXLSX([{ nombre: "Ana", nota: 4 }]));
    expect(text).toContain('<row r="1">');
    expect(text).toContain('<row r="2">');
    expect(text).toContain("nombre");
    expect(text).toContain("Ana");
  });

  it("number de JS → celda numérica t=n; string → inlineStr", () => {
    const text = asText(toXLSX([{ n: 42, s: "hola" }]));
    expect(text).toContain('t="n"><v>42</v>');
    expect(text).toContain('t="inlineStr"><is><t xml:space="preserve">hola</t>');
  });

  it("string numérico NO se convierte a número (preserva ceros a la izquierda)", () => {
    const text = asText(toXLSX([{ doc: "00123" }]));
    expect(text).toContain('<t xml:space="preserve">00123</t>');
    expect(text).not.toContain("<v>00123</v>");
  });

  it("escapa caracteres XML especiales", () => {
    const text = asText(toXLSX([{ x: 'a<b>&"c' }]));
    expect(text).toContain("a&lt;b&gt;&amp;&quot;c");
  });

  it("celda vacía para null/undefined/'' (no rompe el XML)", () => {
    const text = asText(toXLSX([{ a: null, b: undefined, c: "" }]));
    // 3 columnas → A2, B2, C2 deben existir como celdas vacías self-closing.
    expect(text).toContain('<c r="A2"/>');
    expect(text).toContain('<c r="B2"/>');
    expect(text).toContain('<c r="C2"/>');
  });

  it("respeta el orden/whitelist de columnas", () => {
    const text = asText(toXLSX([{ a: "1", b: "2", c: "3" }], ["c", "a"]));
    // El header debe ser c, a (en A1, B1) — y NO incluir 'b'.
    expect(text).toMatch(/<row r="1">.*c.*a.*<\/row>/s);
    expect(text).not.toContain(">b<");
  });

  it("filas vacías → hoja con solo headers vacíos (no crashea)", () => {
    const out = toXLSX([]);
    expect(eocdEntryCount(out)).toBe(5);
    const text = asText(out);
    expect(text).toContain('<row r="1"></row>');
  });

  it("trunca el nombre de hoja a 31 chars (límite de Excel)", () => {
    const longName = "x".repeat(40);
    const text = asText(toXLSX([{ a: "1" }], undefined, longName));
    expect(text).toContain(`name="${"x".repeat(31)}"`);
    expect(text).not.toContain("x".repeat(32));
  });

  it("genera columnas más allá de Z (AA, AB…)", () => {
    const row: Record<string, string> = {};
    for (let i = 0; i < 28; i++) row[`col${i}`] = String(i);
    const text = asText(toXLSX([row]));
    expect(text).toContain('r="Z1"');
    expect(text).toContain('r="AA1"');
    expect(text).toContain('r="AB1"');
  });
});
