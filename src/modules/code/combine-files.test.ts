import { describe, it, expect } from "vitest";
import { combineFilesForExec } from "./combine-files";

describe("combineFilesForExec", () => {
  it("retorna vacío sin archivos", () => {
    expect(combineFilesForExec([], "python")).toBe("");
  });

  it("un solo archivo: retorna su contenido tal cual (caso notebook/codefile)", () => {
    const script = "print('hola')\nprint('mundo')";
    expect(combineFilesForExec([{ filename: "notebook.py", content: script }], "python")).toBe(
      script,
    );
  });

  it("un solo archivo NO vacío: no le antepone encabezado", () => {
    const out = combineFilesForExec([{ filename: "a.py", content: "x=1" }], "python");
    expect(out).toBe("x=1");
    expect(out).not.toContain("───");
  });

  it("ignora archivos vacíos al elegir la lista", () => {
    const out = combineFilesForExec(
      [
        { filename: "a.py", content: "   " },
        { filename: "b.py", content: "print(1)" },
      ],
      "python",
    );
    // queda 1 no vacío → retorna su contenido sin encabezado
    expect(out).toBe("print(1)");
  });

  it("python multi-archivo: encabezado con `#` (no `//`, que es SyntaxError en Python)", () => {
    const out = combineFilesForExec(
      [
        { filename: "a.py", content: "import b" },
        { filename: "b.py", content: "def f(): pass" },
      ],
      "python",
    );
    expect(out).toBe("# ─── a.py ───\nimport b\n\n# ─── b.py ───\ndef f(): pass");
    expect(out).not.toContain("//");
  });

  it("javascript multi-archivo: mantiene encabezado con `//`", () => {
    const out = combineFilesForExec(
      [
        { filename: "a.js", content: "const x = 1;" },
        { filename: "b.js", content: "const y = 2;" },
      ],
      "javascript",
    );
    expect(out).toBe("// ─── a.js ───\nconst x = 1;\n\n// ─── b.js ───\nconst y = 2;");
  });

  it("java multi-archivo: pone primero la clase con main y degrada public en secundarios", () => {
    const helper = "public class Helper { int x; }";
    const main =
      "public class Main { public static void main(String[] args) { System.out.println(1); } }";
    const out = combineFilesForExec(
      [
        { filename: "Helper.java", content: helper },
        { filename: "Main.java", content: main },
      ],
      "java",
    );
    // Main (con main) va primero, conserva su public.
    expect(out.indexOf("class Main")).toBeLessThan(out.indexOf("class Helper"));
    expect(out).toContain("public class Main");
    // Helper queda como secundario → public removido.
    expect(out).toContain("class Helper");
    expect(out).not.toContain("public class Helper");
  });

  it("java: quita package de los secundarios", () => {
    const main =
      "public class Main { public static void main(String[] args) {} }";
    const other = "package com.x;\npublic class Other {}";
    const out = combineFilesForExec(
      [
        { filename: "Main.java", content: main },
        { filename: "Other.java", content: other },
      ],
      "java",
    );
    expect(out).not.toContain("package com.x;");
    expect(out).toContain("class Other");
  });

  it("java sin main: respeta orden original", () => {
    const out = combineFilesForExec(
      [
        { filename: "A.java", content: "public class A {}" },
        { filename: "B.java", content: "public class B {}" },
      ],
      "java",
    );
    expect(out.indexOf("class A")).toBeLessThan(out.indexOf("class B"));
  });
});
