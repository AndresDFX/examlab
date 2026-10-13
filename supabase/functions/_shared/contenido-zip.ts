/**
 * Qué puede traer el ZIP de una entrega `codigo_zip`, configurable por entrega en
 * `options.zip` de `project_files` (y de `workshop_questions`, que tiene la misma columna):
 *
 *   - "codigo"     (por defecto): solo código fuente, como siempre. Esta política NO pasa por este
 *                  módulo: la validan `validateCodeArchive` en el navegador y el bloque de siempre en
 *                  `ai-grade-submission`, para que las entregas de código no cambien en nada.
 *   - "documentos": código de CUALQUIER lenguaje, la configuración de un proyecto, documentos,
 *                  presentaciones, hojas de cálculo, texto, diagramas e imágenes. El lenguaje de la entrega no
 *                  acota: un proyecto real trae `build.xml`, `.sql` o `manifest.mf` aunque sea de Java.
 *   - "cualquiera": cualquier archivo.
 *   - "lista":      solo las extensiones que fije el docente (nada más: ni siquiera un Dockerfile).
 *
 * La regla se lee de la entrega AL CALIFICAR: cambiarla después hace que una recalificación rechace lo
 * que antes se aceptó.
 *
 * UN solo módulo para las dos puntas: lo importan el navegador (`src/shared/lib/code-upload.ts`: qué
 * deja subir) y `ai-grade-submission` (qué acepta el servidor). Si cada lado tuviera su lista, el
 * estudiante podría subir algo que el servidor rechaza recién al calificar. Por eso es TypeScript puro:
 * sin Deno, sin `npm:` y sin `@/`.
 */

export type ContenidoZip = "codigo" | "documentos" | "cualquiera" | "lista";
export const CONTENIDOS_ZIP: readonly ContenidoZip[] = ["codigo", "documentos", "cualquiera", "lista"];

export interface PoliticaZip {
  contenido: ContenidoZip;
  /** Solo para «lista». */
  extensiones: string[];
}

/** Lo que agrega «documentos» a las extensiones de código (de TODOS los lenguajes). */
export const EXT_DOCUMENTOS: readonly string[] = [
  // configuración de un proyecto (NetBeans trae manifest.mf y project.properties)
  "properties", "mf", "ini", "cfg", "conf",
  "pdf", "doc", "docx", "odt", "rtf", "txt", "md",
  "ppt", "pptx", "odp",
  "xls", "xlsx", "ods", "csv", "tsv",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp",
  "drawio", "mmd", "puml", "mdj",
];

/**
 * Archivos sin extensión que son parte normal de un proyecto. Con «documentos» se aceptan: un Dockerfile
 * es el corazón de una entrega de contenedores y no tiene extensión. Con «lista», no: ahí manda lo escrito.
 */
export const NOMBRES_SIN_EXTENSION: readonly string[] = [
  "dockerfile", "makefile", "procfile", "jenkinsfile", "readme", "license", "gemfile", "rakefile",
];

/** Lo que la IA lee como TEXTO además del código (los .docx, .pptx y .pdf se leen aparte). */
export const EXT_TEXTO_LEGIBLE: readonly string[] = [
  "txt", "md", "csv", "tsv", "mmd", "puml", "svg", "drawio", "mdj",
];

const MAX_EXTENSIONES = 40;

/** «pdf, .docx  java» o ["PDF", ".docx"] → ["pdf", "docx", "java"]. Descarta lo que no es una extensión. */
export function normalizarExtensiones(x: unknown): string[] {
  const crudo = Array.isArray(x) ? x : typeof x === "string" ? x.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const e of crudo) {
    if (typeof e !== "string") continue;
    const limpia = e.trim().toLowerCase().replace(/^\*?\./, "");
    if (!/^[a-z0-9]{1,15}$/.test(limpia) || out.includes(limpia)) continue;
    out.push(limpia);
    if (out.length >= MAX_EXTENSIONES) break;
  }
  return out;
}

export function leerPoliticaZip(options: unknown): PoliticaZip {
  const zip =
    options && typeof options === "object" && !Array.isArray(options)
      ? (options as { zip?: unknown }).zip
      : undefined;
  const z = zip && typeof zip === "object" ? (zip as { contenido?: unknown; extensiones?: unknown }) : {};
  const contenido = CONTENIDOS_ZIP.includes(z.contenido as ContenidoZip)
    ? (z.contenido as ContenidoZip)
    : "codigo";
  if (contenido !== "lista") return { contenido, extensiones: [] };
  const extensiones = normalizarExtensiones(z.extensiones);
  // Una lista vacía haría la entrega imposible: se vuelve al comportamiento de siempre.
  return extensiones.length > 0 ? { contenido, extensiones } : { contenido: "codigo", extensiones: [] };
}

/**
 * Las extensiones que acepta la entrega; `null` = cualquier archivo. `delCodigo`: con «codigo», las del
 * lenguaje de la entrega o la lista general; con «documentos», la lista general de código de quien llama
 * (el navegador y el servidor tienen cada uno la suya).
 */
export function extensionesPermitidas(p: PoliticaZip, delCodigo: readonly string[]): string[] | null {
  if (p.contenido === "cualquiera") return null;
  if (p.contenido === "lista") return [...p.extensiones];
  if (p.contenido === "documentos") return [...new Set([...delCodigo, ...EXT_DOCUMENTOS])];
  return [...delCodigo];
}

/** Guarda la política en `options` sin tocar lo demás. «codigo» es el valor por defecto: no deja rastro. */
export function opcionesConPoliticaZip(options: unknown, p: PoliticaZip): Record<string, unknown> | null {
  const base: Record<string, unknown> =
    options && typeof options === "object" && !Array.isArray(options)
      ? { ...(options as Record<string, unknown>) }
      : {};
  delete base.zip;
  if (p.contenido === "lista") {
    const extensiones = normalizarExtensiones(p.extensiones);
    if (extensiones.length > 0) base.zip = { contenido: "lista", extensiones };
  } else if (p.contenido !== "codigo") {
    base.zip = { contenido: p.contenido };
  }
  return Object.keys(base).length > 0 ? base : null;
}

/** Ruido del sistema, del IDE o de la compilación: ni se rechaza ni se lee. */
export function esRuidoDeZip(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  if (base === ".ds_store" || base === "thumbs.db" || base === "desktop.ini") return true;
  if (/(^|\/)(__macosx|\.git|\.idea|\.vscode|node_modules|target|build|out|dist|\.gradle)\//.test(lower)) {
    return true;
  }
  return /(^|\/)bin\//.test(lower) && /\.(class|exe)$/.test(lower);
}

/** Extensión en minúscula, sin el punto; "" si no tiene o es un archivo oculto sin extensión. */
export function extensionDe(path: string): string {
  const base = path.toLowerCase().split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

/**
 * Revisa los archivos de un ZIP contra una política que NO es «codigo». `permitidas` = null acepta todo;
 * `sinExtension` acepta además los de `NOMBRES_SIN_EXTENSION` (va solo con «documentos»). Los ocultos
 * (.gitignore, .env…) y el ruido se ignoran: no se rechazan —vienen solos al comprimir una carpeta— ni se
 * mandan a la IA.
 *
 * `esRuidoDeZip` es la TERCERA copia de las reglas de ruido (con `NOISE_PATTERNS` de `code-extensions.ts`
 * y `isToleratedNoise` de `ai-grade-submission`): esas dos gobiernan «codigo» y esta, lo demás.
 */
export function revisarArchivosDelZip(
  paths: string[],
  permitidas: readonly string[] | null,
  { sinExtension = false }: { sinExtension?: boolean } = {},
): { aceptados: string[]; rechazados: string[] } {
  const aceptados: string[] = [];
  const rechazados: string[] = [];
  for (const p of paths) {
    if (p.endsWith("/") || esRuidoDeZip(p)) continue;
    const base = p.toLowerCase().split("/").pop() ?? "";
    if (!base || base.startsWith(".")) continue;
    if (permitidas === null) {
      aceptados.push(p);
      continue;
    }
    const ext = extensionDe(p);
    const ok = ext ? permitidas.includes(ext) : sinExtension && NOMBRES_SIN_EXTENSION.includes(base);
    (ok ? aceptados : rechazados).push(p);
  }
  return { aceptados, rechazados };
}

/** Topes para leer PDF dentro del ZIP: el servidor corta la función que pasa de ~2 s de CPU. */
export const PDF_MAX_ARCHIVOS = 3;
export const PDF_MAX_PAGINAS = 8;
export const PDF_PRESUPUESTO_MS = 900;
