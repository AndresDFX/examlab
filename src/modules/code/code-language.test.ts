import { describe, expect, it } from "vitest";
import { getStarterCode, JAVA_STARTER, type CodeLanguage } from "./CodeEditor";
import { providersForLanguage } from "./CodeRunnerPicker";

describe("getStarterCode", () => {
  it("Java retorna el JAVA_STARTER (public class Main + println)", () => {
    const out = getStarterCode("java");
    expect(out).toBe(JAVA_STARTER);
    expect(out).toContain("public class Main");
    expect(out).toContain("System.out.println");
  });

  it("Python retorna un starter con el idiom profesional main() + guard", () => {
    const out = getStarterCode("python");
    expect(out).toContain("def main():");
    expect(out).toContain('if __name__ == "__main__":');
    expect(out).toContain("print(");
  });

  it("JavaScript retorna un console.log mínimo", () => {
    expect(getStarterCode("javascript")).toBe(`console.log("¡Hola, mundo!");`);
  });

  it("lenguaje desconocido (string libre) retorna vacío", () => {
    // CodeLanguage está tipado pero el código real recibe strings de la DB
    // que pueden ser "html", "kotlin", "" o legacy raros. NO debe romper.
    expect(getStarterCode("kotlin" as CodeLanguage)).toBe("");
    expect(getStarterCode("html" as CodeLanguage)).toBe("");
    expect(getStarterCode("" as CodeLanguage)).toBe("");
  });

  it("null y undefined retornan vacío (NO 'undefined' como string)", () => {
    // Crítico: q.language puede ser null en DB. Si retornáramos "undefined"
    // el editor mostraría literalmente esa palabra como starter — peor que
    // mostrar vacío.
    expect(getStarterCode(null)).toBe("");
    expect(getStarterCode(undefined)).toBe("");
  });

  it("los starters de Python/JS son válidos para los ejecutores correspondientes", () => {
    // Smoke check de contenido — si el day-one estudiante corre el starter
    // sin tocarlo, debe imprimir algo y terminar limpio. No verificamos la
    // ejecución real (eso es integration test); solo que el código tiene
    // forma correcta del lenguaje.
    expect(getStarterCode("python")).toContain("print(");
    expect(getStarterCode("javascript")).toMatch(/console\.log\(/);
  });
});

describe("providersForLanguage", () => {
  it("Java permite los 4 providers (cheerp es Java-only pero válido)", () => {
    const out = providersForLanguage("java");
    expect(out).toContain("cheerp");
    expect(out).toContain("aws_lambda");
    expect(out).toContain("onlinecompiler");
    expect(out).toContain("jdoodle");
    expect(out).toHaveLength(4);
  });

  it("Python excluye cheerp (no hay JVM Python en WebAssembly)", () => {
    const out = providersForLanguage("python");
    expect(out).not.toContain("cheerp");
    expect(out).toContain("aws_lambda");
    expect(out).toContain("onlinecompiler");
    expect(out).toContain("jdoodle");
    expect(out).toHaveLength(3);
  });

  it("JavaScript excluye cheerp también", () => {
    const out = providersForLanguage("javascript");
    expect(out).not.toContain("cheerp");
    expect(out).toHaveLength(3);
  });

  it("nunca devuelve duplicados", () => {
    const java = providersForLanguage("java");
    expect(new Set(java).size).toBe(java.length);
    const py = providersForLanguage("python");
    expect(new Set(py).size).toBe(py.length);
  });
});
