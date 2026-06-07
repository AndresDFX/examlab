import { describe, expect, it } from "vitest";
import {
  BLOCKED_FILENAMES,
  CODE_EXTENSIONS,
  getExt,
  isToleratedNoise,
  validateCodeArchive,
} from "./code-extensions";

describe("getExt", () => {
  it("extrae la extension en lowercase sin punto", () => {
    expect(getExt("Main.java")).toBe("java");
    expect(getExt("src/utils/helpers.TS")).toBe("ts");
  });

  it("retorna '' para archivos sin extension", () => {
    expect(getExt("Makefile")).toBe("");
    expect(getExt("src/README")).toBe("");
  });

  it("retorna '' para archivos ocultos sin extension propia (idx <= 0)", () => {
    expect(getExt(".gitignore")).toBe("");
    expect(getExt(".env")).toBe("");
  });

  it("toma solo el basename, ignora puntos en directorios padres", () => {
    expect(getExt("path.with.dots/file.py")).toBe("py");
  });

  it("usa la ultima extension cuando hay varias", () => {
    expect(getExt("archive.tar.gz")).toBe("gz");
    expect(getExt("Component.test.tsx")).toBe("tsx");
  });
});

describe("isToleratedNoise", () => {
  it("reconoce ruido del SO macOS / Windows por basename", () => {
    expect(isToleratedNoise(".DS_Store")).toBe(true);
    expect(isToleratedNoise("subdir/.ds_store")).toBe(true);
    expect(isToleratedNoise("Thumbs.db")).toBe(true);
    expect(isToleratedNoise("desktop.ini")).toBe(true);
  });

  it("reconoce __MACOSX/ como ruido", () => {
    expect(isToleratedNoise("__MACOSX/Main.java")).toBe(true);
    expect(isToleratedNoise("nested/__macosx/file.txt")).toBe(true);
  });

  it("reconoce directorios de VCS / IDE / build como ruido", () => {
    expect(isToleratedNoise(".git/HEAD")).toBe(true);
    expect(isToleratedNoise(".idea/workspace.xml")).toBe(true);
    expect(isToleratedNoise(".vscode/settings.json")).toBe(true);
    expect(isToleratedNoise("node_modules/lodash/index.js")).toBe(true);
    expect(isToleratedNoise("target/classes/Main.class")).toBe(true);
    expect(isToleratedNoise("build/output.jar")).toBe(true);
    expect(isToleratedNoise("dist/bundle.js")).toBe(true);
  });

  it("tolera .class/.exe dentro de bin/ (compilados Eclipse)", () => {
    expect(isToleratedNoise("bin/Main.class")).toBe(true);
    expect(isToleratedNoise("project/bin/app.exe")).toBe(true);
  });

  it("NO marca como ruido archivos legitimos de codigo", () => {
    expect(isToleratedNoise("src/Main.java")).toBe(false);
    expect(isToleratedNoise("app/index.ts")).toBe(false);
    expect(isToleratedNoise("README.md")).toBe(false);
  });
});

describe("validateCodeArchive", () => {
  it("happy path: solo paths permitidos → ok=true", () => {
    const result = validateCodeArchive(["src/Main.java", "src/Util.java"], null);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["src/Main.java", "src/Util.java"]);
    expect(result.violations).toEqual([]);
  });

  it("retorna ok=true y listas vacias para input vacio", () => {
    const result = validateCodeArchive([], null);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("ignora paths de ruido (__MACOSX, .git, node_modules) sin contarlos", () => {
    const result = validateCodeArchive(
      [
        "src/Main.java",
        "__MACOSX/Main.java",
        ".git/HEAD",
        "node_modules/lodash/index.js",
      ],
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["src/Main.java"]);
    expect(result.violations).toEqual([]);
  });

  it("bloquea filenames vetados (.gitignore, .env) incluso si no tienen extension", () => {
    const result = validateCodeArchive([".gitignore", ".env", "src/Main.java"], null);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(".gitignore");
    expect(result.violations).toContain(".env");
    expect(result.accepted).toEqual(["src/Main.java"]);
  });

  it("rechaza extensiones fuera de la whitelist global", () => {
    const result = validateCodeArchive(
      ["src/Main.java", "report.pdf", "data.xlsx", "image.png"],
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual(["src/Main.java"]);
    expect(result.violations).toEqual(["report.pdf", "data.xlsx", "image.png"]);
  });

  it("acepta whitelist custom (solo .java)", () => {
    const result = validateCodeArchive(
      ["Main.java", "Util.py", "config.json"],
      ["java"],
    );
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual(["Main.java"]);
    expect(result.violations).toEqual(["Util.py", "config.json"]);
  });

  it("normaliza extensiones custom (acepta '.JAVA', 'java', '  java  ')", () => {
    const result = validateCodeArchive(
      ["Main.java", "Other.JAVA"],
      [".JAVA", "  py  "],
    );
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["Main.java", "Other.JAVA"]);
  });

  it("whitelist vacia [] cae al fallback global CODE_EXTENSIONS", () => {
    const result = validateCodeArchive(["Main.java", "app.py"], []);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["Main.java", "app.py"]);
  });

  it("descarta directorios (paths que terminan en /)", () => {
    const result = validateCodeArchive(["src/", "src/Main.java"], null);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["src/Main.java"]);
    expect(result.violations).toEqual([]);
  });
});

describe("CODE_EXTENSIONS whitelist (invariante cross-file con edge ai-grade-submission)", () => {
  it("incluye los lenguajes principales documentados", () => {
    // Si esta lista cambia, sincronizar con la copia hardcoded en
    // supabase/functions/ai-grade-submission/index.ts
    for (const ext of ["java", "py", "js", "ts", "tsx", "c", "cpp", "cs", "go", "rs"]) {
      expect(CODE_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("incluye configs comunes (json, yaml, xml)", () => {
    expect(CODE_EXTENSIONS.has("json")).toBe(true);
    expect(CODE_EXTENSIONS.has("yaml")).toBe(true);
    expect(CODE_EXTENSIONS.has("xml")).toBe(true);
  });

  it("NO incluye binarios/documentos (pdf, png, exe, class)", () => {
    expect(CODE_EXTENSIONS.has("pdf")).toBe(false);
    expect(CODE_EXTENSIONS.has("png")).toBe(false);
    expect(CODE_EXTENSIONS.has("exe")).toBe(false);
    expect(CODE_EXTENSIONS.has("class")).toBe(false);
  });
});

describe("BLOCKED_FILENAMES", () => {
  it("incluye archivos de config sin extension util", () => {
    expect(BLOCKED_FILENAMES.has(".gitignore")).toBe(true);
    expect(BLOCKED_FILENAMES.has(".env")).toBe(true);
    expect(BLOCKED_FILENAMES.has(".editorconfig")).toBe(true);
  });
});
