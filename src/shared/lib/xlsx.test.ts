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

  // ─────────────── Fila de grupo (sólo Excel) ───────────────

  it("groupHeader → fila de grupo en r1, encabezados en r2, datos en r3", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", parcial: 4 }], undefined, "Datos", {
        groupHeader: { parcial: "Primer corte" },
      }),
    );
    // La fila de grupo va arriba con la etiqueta del corte.
    expect(text).toMatch(/<row r="1">.*Primer corte.*<\/row>/s);
    // El encabezado de columnas baja a la fila 2 y los datos a la 3.
    expect(text).toContain('<row r="2">');
    expect(text).toContain('<row r="3">');
    expect(text).toMatch(/<row r="2">.*nombre.*parcial.*<\/row>/s);
    expect(text).toMatch(/<row r="3">.*Ana.*<\/row>/s);
    // La etiqueta del corte cae bajo la columna "parcial" (B1, no A1).
    expect(text).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">Primer corte</t>');
  });

  it("groupHeader → columnas sin mapear quedan como celda vacía en la fila de grupo", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", parcial: 4, final: 3 }], undefined, "Datos", {
        groupHeader: { parcial: "Primer corte" },
      }),
    );
    // nombre (A) y final (C) no están en el mapa → celdas vacías self-closing.
    expect(text).toContain('<c r="A1"/>');
    expect(text).toContain('<c r="C1"/>');
  });

  it("groupHeader respeta el orden/whitelist de columnas", () => {
    const text = asText(
      toXLSX([{ a: "1", b: "2", c: "3" }], ["c", "a"], "Datos", {
        groupHeader: { c: "Corte X", a: "Corte Y" },
      }),
    );
    // Orden c, a → Corte X en A1, Corte Y en B1; 'b' no aparece.
    expect(text).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Corte X</t>');
    expect(text).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">Corte Y</t>');
    expect(text).not.toContain("Corte Z");
  });

  it("groupHeader NO agrega partes al ZIP (sigue siendo 5)", () => {
    const out = toXLSX([{ nombre: "Ana", parcial: 4 }], undefined, "Datos", {
      groupHeader: { parcial: "Primer corte" },
    });
    expect(eocdEntryCount(out)).toBe(5);
  });

  // ─────────────── Auto-merge de la fila de grupo (sólo Excel) ───────────────

  it("auto-merge: celdas de grupo CONTIGUAS con la misma etiqueta → <mergeCells> con el ref correcto", () => {
    // Tres items del mismo corte (B, C, D) + un final sin grupo (E).
    const out = toXLSX([{ nombre: "Ana", p1: 4, p2: 3, p3: 5, final: 4 }], undefined, "Datos", {
      groupHeader: { p1: "Corte 1 (30%)", p2: "Corte 1 (30%)", p3: "Corte 1 (30%)" },
    });
    const text = asText(out);
    expect(text).toContain('<mergeCells count="1">');
    expect(text).toContain('<mergeCell ref="B1:D1"/>');
    // El bloque va DESPUES de </sheetData> y ANTES de </worksheet>.
    expect(text.indexOf("<mergeCells")).toBeGreaterThan(text.indexOf("</sheetData>"));
    expect(text.indexOf("<mergeCells")).toBeLessThan(text.indexOf("</worksheet>"));
  });

  it("auto-merge: sólo la PRIMERA celda del tramo lleva la etiqueta; el resto va vacío", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", p1: 4, p2: 3 }], undefined, "Datos", {
        groupHeader: { p1: "Corte 1 (30%)", p2: "Corte 1 (30%)" },
      }),
    );
    // B1 (primera del tramo) lleva la etiqueta; C1 queda vacía self-closing.
    expect(text).toContain(
      '<c r="B1" t="inlineStr"><is><t xml:space="preserve">Corte 1 (30%)</t>',
    );
    expect(text).toContain('<c r="C1"/>');
    // La etiqueta aparece EXACTAMENTE una vez en toda la hoja.
    expect(text.split("Corte 1 (30%)").length - 1).toBe(1);
  });

  it("auto-merge: dos cortes contiguos distintos → count=2 con dos <mergeCell>", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", a: 1, b: 2, c: 3, d: 4 }], undefined, "Datos", {
        // a,b → Corte 1 (B,C); c,d → Corte 2 (D,E).
        groupHeader: {
          a: "Corte 1 (30%)",
          b: "Corte 1 (30%)",
          c: "Corte 2 (40%)",
          d: "Corte 2 (40%)",
        },
      }),
    );
    expect(text).toContain('<mergeCells count="2">');
    expect(text).toContain('<mergeCell ref="B1:C1"/>');
    expect(text).toContain('<mergeCell ref="D1:E1"/>');
  });

  it("auto-merge: tramo de UNA sola columna o etiquetas distintas → SIN <mergeCells>", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", p1: 4, p2: 3 }], undefined, "Datos", {
        // Cada columna en su propio corte (longitud 1) → nada que combinar.
        groupHeader: { p1: "Corte 1 (30%)", p2: "Corte 2 (40%)" },
      }),
    );
    expect(text).not.toContain("<mergeCells");
    // Ambas etiquetas se conservan en sus celdas (no se vacían).
    expect(text).toContain('<t xml:space="preserve">Corte 1 (30%)</t>');
    expect(text).toContain('<t xml:space="preserve">Corte 2 (40%)</t>');
  });

  it("auto-merge: etiquetas vacías intercaladas NO unen tramos no adyacentes", () => {
    // a → Corte 1, b sin grupo, c → Corte 1: NO son adyacentes → sin merge.
    const text = asText(
      toXLSX([{ a: 1, b: 2, c: 3 }], undefined, "Datos", {
        groupHeader: { a: "Corte 1 (30%)", c: "Corte 1 (30%)" },
      }),
    );
    expect(text).not.toContain("<mergeCells");
  });

  it("auto-merge: el ZIP sigue teniendo 5 partes (el bloque vive en sheet1.xml)", () => {
    const out = toXLSX([{ nombre: "Ana", p1: 4, p2: 3 }], undefined, "Datos", {
      groupHeader: { p1: "Corte 1 (30%)", p2: "Corte 1 (30%)" },
    });
    expect(eocdEntryCount(out)).toBe(5);
  });

  it("auto-merge: sin groupHeader NO se emite <mergeCells> (sin regresión)", () => {
    const text = asText(toXLSX([{ nombre: "Ana", p1: 4, p2: 3 }]));
    expect(text).not.toContain("<mergeCells");
  });

  it("SIN groupHeader → header en r1 (sin regresión del comportamiento por defecto)", () => {
    // Mismo dataset, sin opciones: el header se mantiene en la fila 1.
    const text = asText(toXLSX([{ nombre: "Ana", parcial: 4 }]));
    expect(text).toMatch(/<row r="1">.*nombre.*<\/row>/s);
    expect(text).toContain('<row r="2">');
    expect(text).not.toContain('<row r="3">');
  });

  // ─────────────── Estilos de celda (color/negrita, sólo Excel) ───────────────

  it("estilos aplicados → 6 partes (se agrega xl/styles.xml)", () => {
    const out = toXLSX([{ nombre: "Ana", nota: 4 }], undefined, "Datos", {
      styles: [{ fill: "FFE7E6E6", bold: true }],
      headerStyle: 1,
    });
    expect(eocdEntryCount(out)).toBe(6);
    const text = asText(out);
    expect(text).toContain("xl/styles.xml");
  });

  it("styles.xml tiene la estructura/orden OOXML requerido", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", nota: 4 }], undefined, "Datos", {
        styles: [
          { fill: "FFE7E6E6", bold: true },
          { fill: "FFD9EAD3" },
        ],
        headerStyle: 1,
        cellStyle: (k) => (k === "nota" ? 2 : undefined),
      }),
    );
    // styleSheet con los hijos en orden: fonts < fills < borders < cellStyleXfs < cellXfs.
    expect(text).toContain("<styleSheet");
    const iFonts = text.indexOf("<fonts");
    const iFills = text.indexOf("<fills");
    const iBorders = text.indexOf("<borders");
    const iCellStyleXfs = text.indexOf("<cellStyleXfs");
    const iCellXfs = text.indexOf("<cellXfs");
    expect(iFonts).toBeGreaterThan(-1);
    expect(iFonts).toBeLessThan(iFills);
    expect(iFills).toBeLessThan(iBorders);
    expect(iBorders).toBeLessThan(iCellStyleXfs);
    expect(iCellStyleXfs).toBeLessThan(iCellXfs);
    // Fills reservados (none + gray125) + el sólido del caller (ARGB 8 hex).
    expect(text).toContain('patternType="none"');
    expect(text).toContain('patternType="gray125"');
    expect(text).toContain('<patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/></patternFill>');
    expect(text).toContain('<fgColor rgb="FFD9EAD3"/>');
    // Fuente bold (index 1) presente porque al menos un estilo la usa.
    expect(text).toContain("<b/>");
    // cellXfs: index 0 default + 2 del caller → count="3".
    expect(text).toContain('<cellXfs count="3">');
  });

  it("style.align → xf con <alignment horizontal> + applyAlignment (para celdas combinadas)", () => {
    const text = asText(
      toXLSX([{ a: 1 }], undefined, "Datos", {
        styles: [{ fill: "FFF2F2F2", bold: true, align: "center" }],
        groupHeader: { a: "G" },
        groupHeaderStyle: 1,
      }),
    );
    expect(text).toContain('applyAlignment="1"');
    expect(text).toContain('<alignment horizontal="center"/>');
    // El xf sin align sigue siendo self-closing (el default, index 0).
    expect(text).toContain('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  });

  it("declara styles.xml en [Content_Types] y en los rels del workbook", () => {
    const text = asText(
      toXLSX([{ a: 1 }], undefined, "Datos", { styles: [{ fill: "FFD9EAD3" }], headerStyle: 1 }),
    );
    expect(text).toContain(
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    );
    expect(text).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"',
    );
  });

  it("headerStyle → el encabezado lleva s= en sus celdas", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", nota: 4 }], undefined, "Datos", {
        styles: [{ fill: "FFE7E6E6", bold: true }],
        headerStyle: 1,
      }),
    );
    // Encabezado en r1: A1/B1 con s="1".
    expect(text).toContain('<c r="A1" s="1"');
    expect(text).toContain('<c r="B1" s="1"');
  });

  it("cellStyle → colorea aprobado (verde) vs reprobado (rojo) por celda de nota", () => {
    // passing=3: 4 aprueba (s=2), 2 reprueba (s=3); el nombre no se colorea.
    const text = asText(
      toXLSX([{ nombre: "Ana", n1: "4.00", n2: "2.00" }], undefined, "Datos", {
        styles: [{ fill: "FFE7E6E6", bold: true }, { fill: "FFD9EAD3" }, { fill: "FFF4CCCC" }],
        headerStyle: 1,
        cellStyle: (k, _r, v) => {
          if (k === "nombre") return undefined;
          const num = parseFloat(String(v));
          if (!Number.isFinite(num)) return undefined;
          return num >= 3 ? 2 : 3;
        },
      }),
    );
    // Datos en r2: A2 (nombre) SIN s=, B2 (n1=4 aprueba) s="2", C2 (n2=2 reprueba) s="3".
    expect(text).toContain('<c r="A2" t="inlineStr">');
    expect(text).toContain('<c r="B2" s="2"');
    expect(text).toContain('<c r="C2" s="3"');
  });

  it("celda de nota vacía ('—') queda sin estilo", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", n1: "" }], undefined, "Datos", {
        styles: [{ fill: "FFD9EAD3" }, { fill: "FFF4CCCC" }],
        cellStyle: (_k, _r, v) => {
          const num = parseFloat(String(v));
          if (!Number.isFinite(num)) return undefined;
          return num >= 3 ? 1 : 2;
        },
      }),
    );
    // n1 vacío → B2 celda vacía self-closing SIN s=.
    expect(text).toContain('<c r="B2"/>');
  });

  it("groupHeaderStyle → fila de grupo coloreada (sólo en celdas con etiqueta)", () => {
    const text = asText(
      toXLSX([{ nombre: "Ana", p1: 4, p2: 3 }], undefined, "Datos", {
        groupHeader: { p1: "Corte 1", p2: "Corte 1" },
        styles: [{ fill: "FFF2F2F2", bold: true }],
        groupHeaderStyle: 1,
      }),
    );
    // B1 (primera del merge, lleva etiqueta) con s="1"; A1 (sin etiqueta) sin s=.
    expect(text).toContain('<c r="B1" s="1"');
    expect(text).toContain('<c r="A1"/>');
    // El merge sigue funcionando con estilos.
    expect(text).toContain('<mergeCell ref="B1:C1"/>');
  });

  it("styles definidos pero NUNCA aplicados → sigue siendo 5 partes (byte-idéntico)", () => {
    // Pasamos `styles` pero NINGÚN índice (sin headerStyle/cellStyle/group) →
    // nadie usó estilo → no se materializa styles.xml.
    const out = toXLSX([{ a: 1 }], undefined, "Datos", { styles: [{ fill: "FFD9EAD3" }] });
    expect(eocdEntryCount(out)).toBe(5);
    const text = asText(out);
    expect(text).not.toContain("xl/styles.xml");
    expect(text).not.toContain(' s="');
    // Idéntico al output sin opción alguna.
    const baseline = asText(toXLSX([{ a: 1 }]));
    expect(text).toBe(baseline);
  });

  it("índice de estilo fuera de rango → se ignora (sin s=, sigue 5 partes)", () => {
    const out = toXLSX([{ a: 1 }], undefined, "Datos", {
      styles: [{ fill: "FFD9EAD3" }],
      headerStyle: 99, // fuera de rango → ignorado
    });
    expect(eocdEntryCount(out)).toBe(5);
    expect(asText(out)).not.toContain(' s="');
  });
});
