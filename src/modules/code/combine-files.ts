/**
 * combineFilesForExec — réplica CLIENTE de `combineFiles` del edge
 * `execute-code` (supabase/functions/execute-code/index.ts).
 *
 * Por qué existe: los callers multi-archivo (NotebookRunnerDialog,
 * CodeFileRunnerDialog, SessionCodeSnippets) mandaban SOLO `files[]` al edge.
 * Un edge `execute-code` con la versión ANTERIOR al soporte multi-archivo
 * ignora `files` y solo lee `sourceCode` → responde `{"error":"Código fuente
 * requerido"}` aunque el cliente sí mandó código. Como el deploy del edge va
 * por "Publish" en Lovable (puede ir atrás del front), combinamos los archivos
 * acá y mandamos TAMBIÉN el `sourceCode` legacy. Así:
 *   - Edge NUEVO: usa `files` (prioridad) → combinado correcto server-side.
 *   - Edge VIEJO: ignora `files`, usa nuestro `sourceCode` → funciona igual.
 *
 * INVARIANTE: esta función debe coincidir bit-a-bit con `combineFiles` del
 * edge. Si cambia una, sincronizar la otra (ver CLAUDE.md, tabla de
 * invariantes cross-file).
 */
export interface ExecFile {
  filename: string;
  content: string;
}

/** Detecta `public static void main(String[] args)` (mismo regex que el edge). */
function javaHasMain(source: string): boolean {
  return /\bpublic\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String\s*(?:\[\s*\]|\.\.\.)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\[\s*\])?\s*\)/.test(
    source,
  );
}

export function combineFilesForExec(files: ExecFile[], language: string): string {
  const nonEmpty = files.filter((f) => (f.content ?? "").trim().length > 0);
  const list = nonEmpty.length > 0 ? nonEmpty : files;
  if (list.length === 0) return "";
  if (list.length === 1) return list[0].content;

  if (language === "java") {
    // Entrada primero. Si ninguno tiene main, dejamos el orden original.
    const mainIdx = list.findIndex((f) => javaHasMain(f.content));
    const ordered =
      mainIdx > 0 ? [list[mainIdx], ...list.filter((_, i) => i !== mainIdx)] : list;
    const parts = ordered.map((f, idx) => {
      let body = f.content;
      if (idx > 0) {
        // Quitar package declarations de secundarios.
        body = body.replace(/^\s*package\s+[^;]+;\s*/m, "");
        // Degradar public class/enum/record/interface a package-private.
        body = body.replace(
          /\bpublic\s+((?:final\s+|abstract\s+)?(?:class|enum|record|interface)\b)/g,
          "$1",
        );
      }
      return body;
    });
    return parts.join("\n\n");
  }

  // Lenguajes script: concatenación con encabezado por archivo. El marcador de
  // comentario depende del lenguaje: `//` en Python es división entera (no
  // comentario) → una línea que empieza con `//` es SyntaxError. Usar `#`.
  const commentPrefix = language === "python" ? "#" : "//";
  return list.map((f) => `${commentPrefix} ─── ${f.filename} ───\n${f.content}`).join("\n\n");
}
