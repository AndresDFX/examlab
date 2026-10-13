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

import { CODE_EXTENSIONS, validateCodeArchive } from "@/shared/lib/code-extensions";
// Módulo puro compartido con `ai-grade-submission` (mismo patrón que `ai-vision.ts`): lo que el
// estudiante puede subir y lo que el servidor acepta salen de las mismas reglas.
import {
  extensionesPermitidas,
  leerPoliticaZip,
  revisarArchivosDelZip,
  type PoliticaZip,
} from "../../../supabase/functions/_shared/contenido-zip.ts";

export {
  leerPoliticaZip,
  normalizarExtensiones,
  opcionesConPoliticaZip,
  type ContenidoZip,
  type PoliticaZip,
} from "../../../supabase/functions/_shared/contenido-zip.ts";

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

/** Qué acepta una entrega `codigo_zip` según cómo la configuró el docente (`options.zip`). */
export interface PermitidosZip {
  politica: PoliticaZip;
  /**
   * Con «codigo»: las del lenguaje, o `null` = la lista general de código (como siempre).
   * Con las demás: la lista final, o `null` = cualquier archivo.
   */
  extensiones: string[] | null;
}

/** `t` de react-i18next: la pantalla lo pasa para que esta librería no importe i18n. */
type Traducir = (clave: string, opciones?: Record<string, unknown>) => string;

export function permitidosDeEntregaZip(
  language: string | null | undefined,
  options: unknown,
): PermitidosZip {
  const politica = leerPoliticaZip(options);
  if (politica.contenido === "codigo") {
    return { politica, extensiones: LANG_TO_EXT[(language ?? "").toLowerCase().trim()] ?? null };
  }
  // «documentos» acepta código de CUALQUIER lenguaje: la lista general, no la del lenguaje.
  return { politica, extensiones: extensionesPermitidas(politica, [...CODE_EXTENSIONS]) };
}

const opcionesDeRevision = (p: PermitidosZip) => ({
  sinExtension: p.politica.contenido === "documentos",
});

/** Un archivo suelto (entrega de varios archivos): ¿lo acepta la entrega? */
export function archivoPermitidoEnEntrega(name: string, p: PermitidosZip): boolean {
  if (p.politica.contenido === "codigo") return isFileAllowed(name, p.extensiones);
  return revisarArchivosDelZip([name], p.extensiones, opcionesDeRevision(p)).rechazados.length === 0;
}

/** Valor del `accept` del selector de archivos; `undefined` = no filtrar. */
export function acceptDeEntrega(p: PermitidosZip): string | undefined {
  return p.extensiones ? p.extensiones.map((e) => `.${e}`).join(",") : undefined;
}

/** Qué acepta la entrega, dicho en palabras: las extensiones de «documentos» son más de cien. */
export function queAceptaLaEntrega(p: PermitidosZip, t: Traducir): string {
  if (p.politica.contenido === "documentos") return t("projectFiles.zipQue.documentos");
  if (p.politica.contenido === "cualquiera") return t("projectFiles.zipQue.cualquiera");
  return p.extensiones
    ? p.extensiones.map((e) => `.${e}`).join(", ")
    : t("hc_modulesProjectsProjectFiles.sourceCodeFiles");
}

/**
 * Valida el ZIP en el navegador antes de subirlo, según la configuración de la entrega. Con «codigo»
 * es exactamente `preValidateZipInBrowser` de siempre.
 */
export async function prevalidarZipDeEntrega(
  zipFile: File,
  p: PermitidosZip,
  t: Traducir,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (p.politica.contenido === "codigo") return preValidateZipInBrowser(zipFile, p.extensiones);
  // «cualquiera» no rechaza nada: no hace falta abrir un ZIP que puede pesar 50 MB.
  if (p.extensiones === null) return { ok: true };
  try {
    const fflate = await import("fflate");
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    // Solo los NOMBRES: con `filter` en false no se descomprime ningún archivo.
    const nombres: string[] = [];
    await new Promise<void>((resolve, reject) => {
      fflate.unzip(
        buf,
        {
          filter: (f) => {
            nombres.push(f.name);
            return false;
          },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const { rechazados } = revisarArchivosDelZip(nombres, p.extensiones, opcionesDeRevision(p));
    if (rechazados.length === 0) return { ok: true };
    const archivos =
      rechazados.slice(0, 5).join(", ") +
      (rechazados.length > 5 ? ` (+${rechazados.length - 5})` : "");
    return {
      ok: false,
      error: t("projectFiles.zipRechazados", { archivos, que: queAceptaLaEntrega(p, t) }),
    };
  } catch {
    return { ok: false, error: t("projectFiles.zipIlegible") };
  }
}
