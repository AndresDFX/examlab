/**
 * Helpers PUROS para Jupyter notebooks (.ipynb) — parse, extracción de
 * código ejecutable y limpieza de outputs para guardar. Sin React ni red,
 * para poder testearlos sin DOM.
 *
 * Contexto: el docente sube un `.ipynb` en Contenidos y el alumno lo abre +
 * ejecuta desde la sesión. La ejecución usa el edge `execute-code` (Python),
 * que es STATELESS — no hay kernel persistente entre celdas. Por eso
 * "ejecutar el notebook" = concatenar TODAS las celdas de código en orden y
 * correrlas como UN solo script Python (top-to-bottom), que es el caso de
 * uso típico de un notebook didáctico. Limitaciones: las magics de Jupyter
 * (`%matplotlib`, `!pip install`) se descartan (no son Python válido) y los
 * plots/figuras no se renderizan (el executor solo devuelve texto).
 */

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  /** Source ya unido a un string (en el .ipynb suele ser string[]). */
  source: string;
}

export interface ParsedNotebook {
  cells: NotebookCell[];
  /** Lenguaje del kernel (metadata) — normalmente "python". */
  language: string;
}

/** True si el nombre de archivo es un Jupyter notebook. */
export function isNotebookFile(name: string | null | undefined): boolean {
  return !!name && name.toLowerCase().endsWith(".ipynb");
}

/** Une un campo `source` de celda (string | string[]) a un solo string. */
function joinSource(source: unknown): string {
  if (Array.isArray(source)) return source.join("");
  return typeof source === "string" ? source : "";
}

/**
 * Parsea el JSON de un .ipynb a una estructura mínima de celdas. Devuelve
 * null si el JSON es inválido o no parece un notebook (sin `cells`).
 */
export function parseNotebook(jsonText: string | null | undefined): ParsedNotebook | null {
  if (!jsonText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = obj as any;
  if (!Array.isArray(raw.cells)) return null;
  const cells: NotebookCell[] = raw.cells.map((c: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cell = c as any;
    const type =
      cell?.cell_type === "markdown" ? "markdown" : cell?.cell_type === "raw" ? "raw" : "code";
    return { cell_type: type, source: joinSource(cell?.source) };
  });
  const language =
    raw.metadata?.kernelspec?.language ||
    raw.metadata?.language_info?.name ||
    "python";
  return { cells, language: String(language) };
}

/**
 * Concatena el código de TODAS las celdas de código en orden, en un único
 * script ejecutable. Descarta líneas de magics de Jupyter (`%…`, `!…`, y
 * cell-magics `%%…`) porque no son Python válido para un intérprete plano.
 * Las celdas vacías se omiten.
 */
// Cell-magics que cambian el INTÉRPRETE de toda la celda (o cuyo cuerpo no se
// debe ejecutar como Python) → descartamos la celda completa. Las que NO cambian
// el intérprete (%%time, %%timeit, %%capture, %%prun, %%pypy…) tienen cuerpo
// Python válido: NO se descartan; el filtro de línea de abajo quita solo la línea
// `%%...` y el cuerpo se ejecuta normal (antes se perdía la celda entera → el
// alumno veía la salida incompleta sin ningún error).
const INTERPRETER_CELL_MAGICS = new Set([
  "bash", "sh", "script", "html", "javascript", "js", "perl", "ruby",
  "latex", "markdown", "md", "svg", "writefile", "python2",
]);

export function notebookCodeToScript(nb: ParsedNotebook | null): string {
  if (!nb) return "";
  const blocks: string[] = [];
  for (const cell of nb.cells) {
    if (cell.cell_type !== "code") continue;
    const lines = cell.source.split("\n");
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
    // Solo descartar la celda si su cell-magic cambia el intérprete (whitelist).
    const cellMagic = firstNonEmpty.match(/^\s*%%(\w+)/);
    if (cellMagic && INTERPRETER_CELL_MAGICS.has(cellMagic[1].toLowerCase())) continue;
    const cleaned = lines
      // Quita sintaxis específica de IPython que NO es Python plano y, al
      // combinarse en UN solo script, provoca un SyntaxError que anula TODA la
      // corrida (el alumno ve 0 output). Descartamos la línea entera:
      //  - magic de línea (`%matplotlib inline`) y comando shell (`!pip install`);
      //  - asignación-shell (`files = !ls`) — no empieza con %/! pero es IPython;
      //  - ayuda (`obj?` / `func??`) — termina en ?, tampoco es Python válido.
      .filter((line) => {
        if (/^\s*[%!]/.test(line)) return false;
        if (/^\s*[\w.]+\s*=\s*!/.test(line)) return false;
        if (/^\s*[\w.()[\]"']+\?{1,2}\s*$/.test(line)) return false;
        return true;
      })
      .join("\n")
      .trim();
    if (cleaned.length > 0) blocks.push(cleaned);
  }
  return blocks.join("\n\n");
}

/**
 * Devuelve una versión "liviana" del .ipynb para guardar inline en
 * `files[].body`: limpia los outputs y execution_count de las celdas de
 * código. Esto evita inflar la fila JSONB con plots/imágenes embebidos en
 * base64 (que pueden pesar MB) — el notebook sigue siendo 100% visible y
 * ejecutable, solo sin los resultados pre-guardados (el alumno los genera al
 * ejecutar). Si el JSON es inválido, devuelve el texto original tal cual.
 */
export function stripNotebookOutputs(jsonText: string): string {
  try {
    const obj = JSON.parse(jsonText);
    if (obj && typeof obj === "object" && Array.isArray(obj.cells)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      obj.cells = obj.cells.map((c: any) => {
        if (c?.cell_type === "code") {
          return { ...c, outputs: [], execution_count: null };
        }
        return c;
      });
    }
    return JSON.stringify(obj);
  } catch {
    return jsonText;
  }
}

/** Conteo de celdas de código no vacías — para mostrar en la UI. */
export function countCodeCells(nb: ParsedNotebook | null): number {
  if (!nb) return 0;
  return nb.cells.filter((c) => c.cell_type === "code" && c.source.trim().length > 0).length;
}
