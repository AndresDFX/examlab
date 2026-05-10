// Helpers para reusar contenido generado (módulo Contenidos) como
// contexto al crear Talleres / Exámenes / Proyectos. La idea: el
// docente ya generó los slides + guía + taller de un tema; en vez de
// volver a describir el tema cuando crea una evaluación, le pasamos
// directamente al asistente IA el texto fuente.

export interface ContentFile {
  name: string;
  path: string;
  kind: "pptx-source" | "md" | "txt";
  body?: string;
}

/**
 * Extrae el número de clase del nombre del archivo. La migración
 * 20260509210000 fuerza al modelo a usar el sufijo `_CLASE_<N>` en
 * curso_completo. Esta regex también acepta variantes laxas como
 * `CLASE 3`, `CLASE-3`, `CLASS_3` por si una versión anterior del
 * prompt produjo nombres diferentes — falla limpia (return null) si
 * no detecta nada.
 */
export function classNumberFromFilename(name: string): number | null {
  const m = name.match(/(?:CLASE|CLASS|SESION|SESSION)[_\s-]*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Devuelve el conjunto de números de clase presentes en el contenido.
 * Útil para poblar un select "Clase N" sin pedirle al docente que
 * adivine cuántas clases hay (puede que la IA no haya respetado el
 * `n_classes` por completo).
 */
export function availableClassNumbers(files: ContentFile[]): number[] {
  const set = new Set<number>();
  for (const f of files) {
    const n = classNumberFromFilename(f.name);
    if (n != null) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * Concatena los `body` de los archivos relevantes con un encabezado
 * que identifica cada uno (para que el modelo distinga slides vs guía
 * vs taller). Si `classNumber` está dado, filtra a archivos cuyo nombre
 * contenga `_CLASE_<N>`. Si no hay match exacto, cae a "todos los
 * archivos" para no devolver string vacío.
 *
 * El resultado se trunca a `maxChars` para no inflar la descripción
 * de la evaluación creada (las descripciones largas se truncan en la
 * UI y aumentan el costo del prompt al generar preguntas).
 */
export function extractContentText(
  files: ContentFile[],
  options: { classNumber?: number | null; maxChars?: number } = {},
): string {
  const { classNumber = null, maxChars = 8000 } = options;

  let relevant = files;
  if (classNumber != null) {
    const filtered = files.filter((f) => classNumberFromFilename(f.name) === classNumber);
    if (filtered.length > 0) relevant = filtered;
  }

  const parts: string[] = [];
  for (const f of relevant) {
    if (!f.body) continue;
    parts.push(`### ${f.name}\n\n${f.body.trim()}`);
  }
  let out = parts.join("\n\n---\n\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 60) + "\n\n[…contenido truncado por longitud…]";
  }
  return out;
}
