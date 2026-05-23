/**
 * Whitelist canónica de extensiones de código fuente + helpers para
 * validar entregas de tipo `codigo_zip` en proyectos.
 *
 * Cliente y server (Deno edge function) DEBEN coincidir en este
 * conjunto. Esta es la fuente de verdad para el cliente; la edge
 * `ai-grade-submission` mantiene una copia hardcoded porque Deno
 * no comparte `src/`. Si agregas o quitas una extensión, actualiza
 * AMBAS — el desync rompe la promesa "lo que aceptamos en el browser
 * lo aceptamos en el server".
 */

/** Set de extensiones de código fuente reconocidas. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  // JVM
  "java",
  "kt",
  "scala",
  "groovy",
  // Python / Ruby / PHP
  "py",
  "rb",
  "php",
  // JavaScript / TypeScript / frontend
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  // C / C++
  "c",
  "cpp",
  "cc",
  "cxx",
  "h",
  "hpp",
  "hxx",
  // .NET
  "cs",
  "fs",
  "vb",
  // Modernos
  "go",
  "rs",
  "swift",
  "m",
  "mm",
  // Datos / scripts / shell
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  // Web
  "html",
  "css",
  "scss",
  "sass",
  "less",
  // Config "de código" — JSON/YAML típicos en proyectos pero son
  // formato de DATOS, no de código. Los mantenemos por compat con
  // proyectos que requieren package.json, tsconfig.json, etc.
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  // Otros lenguajes
  "lua",
  "r",
  "jl",
  "pl",
  "ex",
  "exs",
  "erl",
  "clj",
  "cljs",
  "dart",
  // Build files
  "gradle",
  "makefile",
]);

/** Archivos de config/metadata vetados explícitamente, INDEPENDIENTE de
 *  la extensión. `.gitignore` técnicamente no tiene extensión y pasaría
 *  el filtro; lo bloqueamos por nombre. */
export const BLOCKED_FILENAMES: ReadonlySet<string> = new Set([
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".npmignore",
  ".env",
  ".env.local",
  ".env.example",
  "thumbs.db",
  "desktop.ini",
  ".ds_store",
]);

/** Patrones de "ruido auto-generado" del SO/IDE/build que ignoramos
 *  silenciosamente (no rechazamos, no calificamos). */
const NOISE_PATTERNS = [
  /(^|\/)__macosx\//i,
  /(^|\/)\.git\//i,
  /(^|\/)\.idea\//i,
  /(^|\/)\.vscode\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)target\//i,
  /(^|\/)build\//i,
  /(^|\/)out\//i,
  /(^|\/)dist\//i,
  /(^|\/)\.gradle\//i,
];

/** ¿El path es ruido autogenerado que debemos ignorar (ni rechazar,
 *  ni mandar a IA)? */
export function isToleratedNoise(path: string): boolean {
  const lower = path.toLowerCase();
  const baseName = lower.split("/").pop() ?? "";
  if (baseName === ".ds_store" || baseName === "thumbs.db" || baseName === "desktop.ini") {
    return true;
  }
  for (const re of NOISE_PATTERNS) {
    if (re.test(lower)) return true;
  }
  // Compilados Java dentro de bin/ (típico de Eclipse).
  if (/(^|\/)bin\//.test(lower) && /\.(class|exe)$/i.test(lower)) return true;
  return false;
}

/** Extrae la extensión en lowercase, sin el punto. "" para archivos sin extensión. */
export function getExt(path: string): string {
  const baseName = path.toLowerCase().split("/").pop() ?? "";
  const idx = baseName.lastIndexOf(".");
  if (idx <= 0) return ""; // sin extensión o archivo oculto sin extensión
  return baseName.slice(idx + 1);
}

/**
 * Resultado de `validateCodeArchive`: lista los paths violatorios para
 * mensajes claros + un flag `ok` para gating.
 */
export interface CodeArchiveValidation {
  ok: boolean;
  /** Paths que rompieron el filtro (extensión no permitida o filename vetado). */
  violations: string[];
  /** Paths que pasaron el filtro y se mandarían a IA. */
  accepted: string[];
}

/**
 * Valida un set de paths (típicamente archivos descomprimidos de un
 * ZIP, o nombres de archivos sueltos del flujo multi-file) contra una
 * whitelist de extensiones.
 *
 *   - `allowedExtensions` null/[] → usa la whitelist global `CODE_EXTENSIONS`.
 *   - `allowedExtensions` ["java"] → solo .java pasa.
 *
 * Ignora archivos de ruido (macOS, .git, etc.) — ni cuentan como
 * violación ni como aceptados.
 */
export function validateCodeArchive(
  paths: string[],
  allowedExtensions: string[] | null,
): CodeArchiveValidation {
  const cleaned = (allowedExtensions ?? [])
    .map((e) => e.toLowerCase().replace(/^\./, "").trim())
    .filter(Boolean);
  const whitelist: ReadonlySet<string> = cleaned.length > 0 ? new Set(cleaned) : CODE_EXTENSIONS;
  const violations: string[] = [];
  const accepted: string[] = [];
  for (const p of paths) {
    if (p.endsWith("/")) continue; // directorios
    if (isToleratedNoise(p)) continue;
    const baseName = p.toLowerCase().split("/").pop() ?? "";
    if (BLOCKED_FILENAMES.has(baseName)) {
      violations.push(p);
      continue;
    }
    const ext = getExt(p);
    if (whitelist.has(ext)) {
      accepted.push(p);
    } else {
      violations.push(p);
    }
  }
  return { ok: violations.length === 0, violations, accepted };
}
