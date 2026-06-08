import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  isFileAllowed,
  LANG_OPTIONS,
  LANG_TO_EXT,
  MAX_CODE_FILES_COUNT,
  MAX_CODE_FILES_TOTAL_BYTES,
  preValidateZipInBrowser,
} from "./code-upload";

// ─────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────

describe("constantes de subida de código", () => {
  it("MAX_CODE_FILES_TOTAL_BYTES es 50 MiB", () => {
    expect(MAX_CODE_FILES_TOTAL_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_CODE_FILES_TOTAL_BYTES).toBe(52428800);
  });

  it("MAX_CODE_FILES_COUNT es 50", () => {
    expect(MAX_CODE_FILES_COUNT).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────
// LANG_TO_EXT — mapeo lenguaje → extensiones
// ─────────────────────────────────────────────────────────────────────

describe("LANG_TO_EXT", () => {
  it("mapea cada lenguaje a sus extensiones documentadas", () => {
    expect(LANG_TO_EXT.java).toEqual(["java"]);
    expect(LANG_TO_EXT.python).toEqual(["py"]);
    expect(LANG_TO_EXT.javascript).toEqual(["js", "mjs", "cjs"]);
    expect(LANG_TO_EXT.typescript).toEqual(["ts", "tsx"]);
    expect(LANG_TO_EXT.c).toEqual(["c", "h"]);
    expect(LANG_TO_EXT.cpp).toEqual(["cpp", "cc", "cxx", "hpp", "hxx", "h"]);
    expect(LANG_TO_EXT.csharp).toEqual(["cs"]);
    expect(LANG_TO_EXT.go).toEqual(["go"]);
    expect(LANG_TO_EXT.rust).toEqual(["rs"]);
    expect(LANG_TO_EXT.php).toEqual(["php"]);
    expect(LANG_TO_EXT.ruby).toEqual(["rb"]);
    expect(LANG_TO_EXT.kotlin).toEqual(["kt", "kts"]);
    expect(LANG_TO_EXT.swift).toEqual(["swift"]);
    expect(LANG_TO_EXT.sql).toEqual(["sql"]);
  });

  it("cubre exactamente 14 lenguajes", () => {
    expect(Object.keys(LANG_TO_EXT)).toHaveLength(14);
  });

  it("todas las extensiones son lowercase, sin punto y no vacías", () => {
    for (const exts of Object.values(LANG_TO_EXT)) {
      expect(exts.length).toBeGreaterThan(0);
      for (const ext of exts) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext.startsWith(".")).toBe(false);
        expect(ext.trim()).toBe(ext);
        expect(ext.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// LANG_OPTIONS — opciones del Select del docente
// ─────────────────────────────────────────────────────────────────────

describe("LANG_OPTIONS", () => {
  it("tiene una opción por cada clave de LANG_TO_EXT", () => {
    const optionValues = LANG_OPTIONS.map((o) => o.value);
    const langKeys = Object.keys(LANG_TO_EXT);
    expect(optionValues).toHaveLength(langKeys.length);
    // Mismo conjunto (independiente del orden).
    expect([...optionValues].sort()).toEqual([...langKeys].sort());
  });

  it("preserva el orden canónico del editor (java primero, sql último)", () => {
    expect(LANG_OPTIONS[0].value).toBe("java");
    expect(LANG_OPTIONS[LANG_OPTIONS.length - 1].value).toBe("sql");
  });

  it("cada value es una clave válida de LANG_TO_EXT y label no vacío", () => {
    for (const opt of LANG_OPTIONS) {
      expect(LANG_TO_EXT[opt.value]).toBeDefined();
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("no tiene values duplicados", () => {
    const values = LANG_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isFileAllowed
// ─────────────────────────────────────────────────────────────────────

describe("isFileAllowed", () => {
  it("acepta cualquier archivo cuando allowedExts es null (sin restricción)", () => {
    expect(isFileAllowed("report.pdf", null)).toBe(true);
    expect(isFileAllowed("Main.java", null)).toBe(true);
    expect(isFileAllowed("noext", null)).toBe(true);
    expect(isFileAllowed(".gitignore", null)).toBe(true);
  });

  it("acepta cualquier archivo cuando allowedExts es array vacío", () => {
    expect(isFileAllowed("report.pdf", [])).toBe(true);
    expect(isFileAllowed("Main.java", [])).toBe(true);
  });

  it("happy path: extensión dentro de la whitelist → true", () => {
    expect(isFileAllowed("Main.java", ["java"])).toBe(true);
    expect(isFileAllowed("app.py", ["py", "java"])).toBe(true);
  });

  it("rechaza extensión fuera de la whitelist", () => {
    expect(isFileAllowed("report.pdf", ["java"])).toBe(false);
    expect(isFileAllowed("data.xlsx", ["java", "py"])).toBe(false);
  });

  it("normaliza la extensión del archivo a lowercase antes de comparar", () => {
    expect(isFileAllowed("Main.JAVA", ["java"])).toBe(true);
    expect(isFileAllowed("Component.TSX", ["tsx"])).toBe(true);
  });

  it("NO normaliza la whitelist: una entrada en mayúsculas no matchea (comparación case-sensitive del lado allowed)", () => {
    // El archivo se baja a lowercase, pero allowedExts se compara tal cual.
    expect(isFileAllowed("Main.java", ["JAVA"])).toBe(false);
  });

  it("usa solo el basename (último segmento tras '/')", () => {
    expect(isFileAllowed("src/utils/helpers.ts", ["ts"])).toBe(true);
    expect(isFileAllowed("a/b/c/report.pdf", ["ts"])).toBe(false);
  });

  it("rechaza archivos sin extensión (basename sin punto)", () => {
    expect(isFileAllowed("Makefile", ["java"])).toBe(false);
    expect(isFileAllowed("src/README", ["md"])).toBe(false);
    expect(isFileAllowed("noext", ["txt"])).toBe(false);
  });

  it("rechaza archivos ocultos que empiezan por '.' aunque tengan whitelist", () => {
    expect(isFileAllowed(".gitignore", ["gitignore"])).toBe(false);
    expect(isFileAllowed(".env", ["env"])).toBe(false);
    expect(isFileAllowed("path/.bashrc", ["bashrc"])).toBe(false);
  });

  it("usa la última extensión cuando hay varios puntos", () => {
    expect(isFileAllowed("archive.tar.gz", ["gz"])).toBe(true);
    expect(isFileAllowed("archive.tar.gz", ["tar"])).toBe(false);
    expect(isFileAllowed("Component.test.tsx", ["tsx"])).toBe(true);
  });

  it("trata el punto en directorios padre como no relevante (solo cuenta el basename)", () => {
    expect(isFileAllowed("dir.with.dots/file.py", ["py"])).toBe(true);
    // basename = "noext", sin punto → rechazado, sin importar los puntos del dir.
    expect(isFileAllowed("dir.with.dots/noext", ["py"])).toBe(false);
  });

  it("archivo que termina en punto: basename incluye '.', ext queda vacía → no matchea", () => {
    // "file." -> split(".") -> ["file", ""] -> ext "" no está en la whitelist
    expect(isFileAllowed("file.", ["java"])).toBe(false);
    expect(isFileAllowed("file.", [""])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// preValidateZipInBrowser — usa fflate (dependencia liviana real, sin mock)
// ─────────────────────────────────────────────────────────────────────

function makeZipFile(entries: Record<string, string>, fileName = "code.zip"): File {
  const data: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(entries)) {
    data[path] = strToU8(content);
  }
  const zipped = zipSync(data);
  return new File([zipped], fileName, { type: "application/zip" });
}

describe("preValidateZipInBrowser", () => {
  it("happy path: ZIP solo con código permitido (whitelist global) → ok=true", async () => {
    // .md NO está en CODE_EXTENSIONS; usamos extensiones que sí están en la
    // whitelist global (java/py/json) para el caso feliz.
    const file = makeZipFile({
      "src/Main.java": "class Main {}",
      "src/app.py": "print('hi')",
      "package.json": "{}",
    });
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(true);
    // El branch ok no expone 'error'.
    expect("error" in result).toBe(false);
  });

  it("rechaza .md bajo whitelist global (no es código fuente reconocido)", async () => {
    const file = makeZipFile({
      "src/Main.java": "class Main {}",
      "README.md": "# proyecto",
    });
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("README.md");
    }
  });

  it("respeta whitelist custom: ZIP con .py cuando solo se acepta .java → ok=false", async () => {
    const file = makeZipFile({
      "Main.java": "class Main {}",
      "helper.py": "print('hi')",
    });
    const result = await preValidateZipInBrowser(file, ["java"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("helper.py");
      // allowedLabel para whitelist poblada lista las extensiones permitidas.
      expect(result.error).toContain("Solo se aceptan archivos .java");
      expect(result.error).toContain("Recomprime con SOLO los archivos de código");
    }
  });

  it("ZIP con archivo prohibido bajo whitelist global incluye el mensaje genérico de código fuente", async () => {
    const file = makeZipFile({
      "Main.java": "class Main {}",
      "report.pdf": "%PDF-1.4 binario simulado",
    });
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("report.pdf");
      expect(result.error).toContain(
        "Solo se aceptan archivos de código fuente (.java, .py, .ts, .cpp, etc.)",
      );
      expect(result.error).toContain("PDFs, imágenes y binarios no se permiten");
    }
  });

  it("muestra hasta 5 violaciones en el sample y agrega '+N más' cuando hay más de 5", async () => {
    const entries: Record<string, string> = {};
    // 7 archivos prohibidos (.txt no está en la whitelist global).
    for (let i = 1; i <= 7; i++) entries[`bad${i}.txt`] = "x";
    const file = makeZipFile(entries);
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 7 violaciones → "(+2 más)"
      expect(result.error).toContain("(+2 más)");
    }
  });

  it("NO agrega '+N más' cuando hay exactamente 5 violaciones", async () => {
    const entries: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) entries[`bad${i}.txt`] = "x";
    const file = makeZipFile(entries);
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("más)");
    }
  });

  it("ignora ruido (__MACOSX, .git, node_modules) — no cuenta como violación", async () => {
    const file = makeZipFile({
      "src/Main.java": "class Main {}",
      "__MACOSX/._Main.java": "junk",
      "node_modules/lib/index.js": "module.exports = {}",
    });
    const result = await preValidateZipInBrowser(file, ["java"]);
    expect(result.ok).toBe(true);
  });

  it("ZIP vacío (sin entradas) → ok=true (no hay violaciones)", async () => {
    const file = makeZipFile({});
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(true);
  });

  it("archivo corrupto / no-ZIP → ok=false con mensaje de lectura fallida", async () => {
    const file = new File([strToU8("esto no es un zip")], "fake.zip", {
      type: "application/zip",
    });
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "No se pudo leer el ZIP (corrupto o protegido por contraseña).",
      );
    }
  });

  it("File completamente vacío → ok=false (no es un ZIP válido)", async () => {
    const file = new File([], "empty.zip", { type: "application/zip" });
    const result = await preValidateZipInBrowser(file, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No se pudo leer el ZIP");
    }
  });
});
