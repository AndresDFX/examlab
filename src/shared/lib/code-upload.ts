/**
 * Helpers compartidos por proyectos y talleres para entregas tipo
 * `codigo_zip` (subida de archivos de código fuente, individuales o ZIP
 * único).
 *
 * Antes vivían file-local en `ProjectFiles.tsx`. Se movieron acá cuando
 * los talleres ganaron soporte de `codigo_zip` (migración
 * 20260607010000_workshop_codigo_zip_and_attempts.sql) para evitar
 * duplicar la whitelist/validación en dos archivos — drift acá rompe
 * la promesa "lo mismo se acepta en ambos".
 */

import { validateCodeArchive } from "@/shared/lib/code-extensions";

/** Mapeo lenguaje → extensiones aceptadas para subida multi-archivo. */
export const LANG_TO_EXT: Record<string, string[]> = {
  java: ["java"],
  python: ["py"],
  javascript: ["js", "mjs", "cjs"],
  typescript: ["ts", "tsx"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hxx", "h"],
  csharp: ["cs"],
  go: ["go"],
  rust: ["rs"],
  php: ["php"],
  ruby: ["rb"],
  kotlin: ["kt", "kts"],
  swift: ["swift"],
  sql: ["sql"],
};

/** Opciones canónicas para el Select de lenguaje del editor docente. */
export const LANG_OPTIONS: Array<{ value: keyof typeof LANG_TO_EXT; label: string }> = [
  { value: "java", label: "Java (.java)" },
  { value: "python", label: "Python (.py)" },
  { value: "javascript", label: "JavaScript (.js, .mjs, .cjs)" },
  { value: "typescript", label: "TypeScript (.ts, .tsx)" },
  { value: "c", label: "C (.c, .h)" },
  { value: "cpp", label: "C++ (.cpp, .cc, .h, .hpp)" },
  { value: "csharp", label: "C# (.cs)" },
  { value: "go", label: "Go (.go)" },
  { value: "rust", label: "Rust (.rs)" },
  { value: "php", label: "PHP (.php)" },
  { value: "ruby", label: "Ruby (.rb)" },
  { value: "kotlin", label: "Kotlin (.kt, .kts)" },
  { value: "swift", label: "Swift (.swift)" },
  { value: "sql", label: "SQL (.sql)" },
];

export const MAX_CODE_FILES_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_CODE_FILES_COUNT = 50;

/**
 * Whitelist estricto por extensión. Rechaza hidden (.gitignore, .env) y
 * archivos sin extensión real. Ver detalle en la versión original que
 * vivía en ProjectFiles.tsx.
 */
export function isFileAllowed(name: string, allowedExts: string[] | null): boolean {
  if (!allowedExts || allowedExts.length === 0) return true;
  const base = name.split("/").pop() ?? name;
  if (!base.includes(".") || base.startsWith(".")) return false;
  const ext = (base.split(".").pop() ?? "").toLowerCase();
  return allowedExts.includes(ext);
}

/**
 * Descomprime el ZIP en cliente con fflate y valida que TODOS sus
 * archivos cumplan la whitelist. Evita gastar Storage + IA cuando el
 * estudiante incluyó por error un PDF o binario.
 */
export async function preValidateZipInBrowser(
  zipFile: File,
  allowedExtensions: string[] | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const fflate = await import("fflate");
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    const inner = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      fflate.unzip(buf, (err, files) => (err ? reject(err) : resolve(files)));
    });
    const paths = Object.keys(inner);
    const result = validateCodeArchive(paths, allowedExtensions);
    if (result.ok) return { ok: true };
    const sample = result.violations.slice(0, 5).join(", ");
    const more = result.violations.length > 5 ? ` (+${result.violations.length - 5} más)` : "";
    const allowedLabel =
      allowedExtensions && allowedExtensions.length > 0
        ? `Solo se aceptan archivos ${allowedExtensions.map((e) => `.${e}`).join(", ")}`
        : "Solo se aceptan archivos de código fuente (.java, .py, .ts, .cpp, etc.). PDFs, imágenes y binarios no se permiten en este slot";
    return {
      ok: false,
      error: `El ZIP contiene archivos no permitidos: ${sample}${more}. ${allowedLabel}. Recomprime con SOLO los archivos de código y vuelve a entregar.`,
    };
  } catch {
    return {
      ok: false,
      error: "No se pudo leer el ZIP (corrupto o protegido por contraseña).",
    };
  }
}
