import { describe, expect, it } from "vitest";
import { parseCSV, toCSV } from "./csv";

describe("toCSV", () => {
  it("retorna string vacio cuando rows esta vacio", () => {
    expect(toCSV([])).toBe("");
  });

  it("infiere columnas desde el primer row", () => {
    const csv = toCSV([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    expect(csv).toBe("a,b\n1,x\n2,y");
  });

  it("acepta columnas explicitas y respeta el orden", () => {
    const csv = toCSV(
      [
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ],
      ["b", "a"],
    );
    expect(csv).toBe("b,a\nx,1\ny,2");
  });

  it("escapa valores con comas envolviendo en comillas", () => {
    const csv = toCSV([{ name: "Juan, Perez", age: 30 }]);
    expect(csv).toBe('name,age\n"Juan, Perez",30');
  });

  it("escapa comillas dobles duplicandolas", () => {
    const csv = toCSV([{ comment: 'Dijo "hola"' }]);
    expect(csv).toBe('comment\n"Dijo ""hola"""');
  });

  it("escapa saltos de linea", () => {
    const csv = toCSV([{ text: "line1\nline2" }]);
    expect(csv).toBe('text\n"line1\nline2"');
  });

  it("convierte null/undefined a string vacio", () => {
    const csv = toCSV([{ a: null, b: undefined, c: 0 }]);
    expect(csv).toBe("a,b,c\n,,0");
  });

  it("neutraliza celdas de fórmula (CSV injection: = + - @) con apóstrofo", () => {
    const csv = toCSV([{ name: '=HYPERLINK("http://evil","x")' }]);
    // Se antepone ' y, por contener comillas/coma, va entrecomillado.
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(toCSV([{ v: "@SUM(A1)" }])).toBe("v\n'@SUM(A1)");
    expect(toCSV([{ v: "+1+1" }])).toBe("v\n'+1+1");
  });

  it("NO antepone apóstrofo a números legítimos (incl. negativos y decimales con coma)", () => {
    expect(toCSV([{ v: -5 }])).toBe("v\n-5");
    expect(toCSV([{ v: "-5" }])).toBe("v\n-5");
    expect(toCSV([{ v: "4,5" }])).toBe('v\n"4,5"'); // coma → entrecomillado, sin apóstrofo
    expect(toCSV([{ v: "-3.14" }])).toBe("v\n-3.14");
  });
});

describe("parseCSV", () => {
  it("retorna [] para input vacio", () => {
    expect(parseCSV("")).toEqual([]);
    expect(parseCSV("   ")).toEqual([]);
  });

  it("parsea CSV simple con headers", () => {
    const rows = parseCSV("a,b\n1,x\n2,y");
    expect(rows).toEqual([
      { a: "1", b: "x" },
      { a: "2", b: "y" },
    ]);
  });

  it("trimea headers", () => {
    const rows = parseCSV("  a  ,  b  \n1,x");
    expect(rows).toEqual([{ a: "1", b: "x" }]);
  });

  it("ignora carriage returns (Windows line endings)", () => {
    const rows = parseCSV("a,b\r\n1,x\r\n2,y");
    expect(rows).toEqual([
      { a: "1", b: "x" },
      { a: "2", b: "y" },
    ]);
  });

  it("descarta lineas vacias", () => {
    const rows = parseCSV("a,b\n1,x\n\n2,y\n");
    expect(rows.length).toBe(2);
  });

  it("respeta comas dentro de comillas", () => {
    const rows = parseCSV('name,age\n"Juan, Perez",30');
    expect(rows).toEqual([{ name: "Juan, Perez", age: "30" }]);
  });

  it("interpreta comillas dobles escapadas", () => {
    const rows = parseCSV('comment\n"Dijo ""hola"""');
    expect(rows).toEqual([{ comment: 'Dijo "hola"' }]);
  });

  it("celdas faltantes quedan como string vacio", () => {
    const rows = parseCSV("a,b,c\n1,,3");
    expect(rows).toEqual([{ a: "1", b: "", c: "3" }]);
  });

  it("roundtrip toCSV → parseCSV preserva la info", () => {
    const input = [
      { id: "1", name: "Juan, Perez", note: 'Con "comillas"' },
      { id: "2", name: "Maria", note: "" },
    ];
    const csv = toCSV(input);
    const parsed = parseCSV(csv);
    expect(parsed).toEqual(input);
  });

  it("preserva saltos de línea dentro de un campo entrecomillado (no rompe la fila)", () => {
    const rows = parseCSV('a,b\n"multi\nlinea",x\n2,y');
    expect(rows).toEqual([
      { a: "multi\nlinea", b: "x" },
      { a: "2", b: "y" },
    ]);
  });

  it("roundtrip de un campo multilínea (ej. defense_notes)", () => {
    const input = [{ id: "1", note: "linea1\nlinea2\nlinea3" }];
    const csv = toCSV(input);
    expect(parseCSV(csv)).toEqual(input);
  });
});
