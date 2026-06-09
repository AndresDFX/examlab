import { describe, expect, it } from "vitest";
import {
  isNotebookFile,
  parseNotebook,
  notebookCodeToScript,
  stripNotebookOutputs,
  countCodeCells,
} from "./notebook";

const NB = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Título\n", "Intro"] },
    { cell_type: "code", source: ["import math\n", "print(math.pi)"], outputs: [{ text: "3.14" }], execution_count: 1 },
    { cell_type: "code", source: "%matplotlib inline\nx = 2\nprint(x)", outputs: [], execution_count: 2 },
    { cell_type: "code", source: "   " },
    { cell_type: "raw", source: "raw stuff" },
  ],
  metadata: { kernelspec: { language: "python" } },
  nbformat: 4,
});

describe("isNotebookFile", () => {
  it("detecta .ipynb (case-insensitive)", () => {
    expect(isNotebookFile("clase.ipynb")).toBe(true);
    expect(isNotebookFile("Clase.IPYNB")).toBe(true);
    expect(isNotebookFile("clase.py")).toBe(false);
    expect(isNotebookFile(null)).toBe(false);
    expect(isNotebookFile(undefined)).toBe(false);
  });
});

describe("parseNotebook", () => {
  it("parsea celdas + lenguaje del kernel", () => {
    const nb = parseNotebook(NB);
    expect(nb).not.toBeNull();
    expect(nb!.language).toBe("python");
    expect(nb!.cells).toHaveLength(5);
    expect(nb!.cells[0].cell_type).toBe("markdown");
    expect(nb!.cells[0].source).toBe("# Título\nIntro");
    expect(nb!.cells[1].cell_type).toBe("code");
    expect(nb!.cells[1].source).toBe("import math\nprint(math.pi)");
  });

  it("acepta source como string o como string[]", () => {
    const nb = parseNotebook(NB);
    expect(nb!.cells[2].source).toBe("%matplotlib inline\nx = 2\nprint(x)"); // string
    expect(nb!.cells[0].source).toBe("# Título\nIntro"); // string[]
  });

  it("default language python si no hay metadata", () => {
    const nb = parseNotebook(JSON.stringify({ cells: [] }));
    expect(nb!.language).toBe("python");
  });

  it("lee language_info.name si no hay kernelspec.language", () => {
    const nb = parseNotebook(
      JSON.stringify({ cells: [], metadata: { language_info: { name: "python3" } } }),
    );
    expect(nb!.language).toBe("python3");
  });

  it("null si JSON inválido", () => {
    expect(parseNotebook("{no json")).toBeNull();
    expect(parseNotebook("")).toBeNull();
    expect(parseNotebook(null)).toBeNull();
  });

  it("null si no tiene cells[]", () => {
    expect(parseNotebook(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseNotebook(JSON.stringify({ cells: "nope" }))).toBeNull();
  });
});

describe("notebookCodeToScript", () => {
  it("concatena solo celdas de código, en orden, sin las vacías", () => {
    const nb = parseNotebook(NB);
    const script = notebookCodeToScript(nb);
    // Celda 1 (import math) + celda 2 (x=2, sin la magic) — la vacía y las
    // markdown/raw se omiten.
    expect(script).toContain("import math");
    expect(script).toContain("print(math.pi)");
    expect(script).toContain("x = 2");
    expect(script).toContain("print(x)");
  });

  it("descarta líneas de magics (%, %%) y shell (!)", () => {
    const nb = parseNotebook(NB);
    const script = notebookCodeToScript(nb);
    expect(script).not.toContain("%matplotlib");
    const nb2 = parseNotebook(
      JSON.stringify({ cells: [{ cell_type: "code", source: "!pip install numpy\nimport numpy" }] }),
    );
    const s2 = notebookCodeToScript(nb2);
    expect(s2).not.toContain("pip install");
    expect(s2).toContain("import numpy");
  });

  it("separa bloques con doble salto de línea", () => {
    const nb = parseNotebook(NB);
    const script = notebookCodeToScript(nb);
    expect(script).toContain("\n\n");
  });

  it("string vacío si no hay notebook o no hay código", () => {
    expect(notebookCodeToScript(null)).toBe("");
    const nb = parseNotebook(JSON.stringify({ cells: [{ cell_type: "markdown", source: "hi" }] }));
    expect(notebookCodeToScript(nb)).toBe("");
  });
});

describe("stripNotebookOutputs", () => {
  it("limpia outputs y execution_count de celdas de código", () => {
    const stripped = stripNotebookOutputs(NB);
    const obj = JSON.parse(stripped);
    const codeCells = obj.cells.filter((c: { cell_type: string }) => c.cell_type === "code");
    for (const c of codeCells) {
      expect(c.outputs).toEqual([]);
      expect(c.execution_count).toBeNull();
    }
    // El source se preserva.
    expect(obj.cells[1].source).toEqual(["import math\n", "print(math.pi)"]);
  });

  it("devuelve el texto original si el JSON es inválido", () => {
    expect(stripNotebookOutputs("{nope")).toBe("{nope");
  });
});

describe("countCodeCells", () => {
  it("cuenta celdas de código no vacías", () => {
    const nb = parseNotebook(NB);
    expect(countCodeCells(nb)).toBe(2); // las 2 con código real; la vacía no
  });
  it("0 si null", () => {
    expect(countCodeCells(null)).toBe(0);
  });
});
