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
 * curso_completo. Esta función acepta varias variantes porque, en la
 * práctica, los modelos a veces ignoran el contrato y devuelven
 * filenames como `PRESENTACION_3.PPTX` sin el infix `CLASE_`. Sin un
 * fallback, el modal "Ver archivos por clase" termina mostrando todos
 * los archivos en "Introducción" (Bug reportado al regenerar un curso
 * de Python con 8 clases — todos los archivos quedaban sin agrupar).
 *
 * Orden de patrones (de más específico a más laxo):
 *   1) `CLASE_3` / `CLASS_3` / `SESION_3` / `SESSION_3` (contrato oficial)
 *   2) Trailing `_3.EXT` o `_3` al final  (e.g. PRESENTACION_3.PPTX)
 *   3) Leading `3_` al inicio              (e.g. 3_PRESENTACION.PPTX)
 *
 * Restringimos N a 1..100 para no confundir versiones (`v2.0`), años
 * (`2024`) o IDs largos con números de clase. Falla limpia (null) si
 * no detecta nada — el caller cae al grupo "intro" / "materiales".
 */
export function classNumberFromFilename(name: string): number | null {
  // Pattern 1: contrato oficial (CLASE/CLASS/SESION/SESSION + N).
  const m1 = name.match(/(?:CLASE|CLASS|SESION|SESSION)[_\s-]*(\d+)/i);
  if (m1) {
    const n = Number(m1[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  // Pattern 2: trailing `_N` o `_N.<ext>` — el caso típico cuando el
  // modelo abrevia y solo deja el número al final.
  const m2 = name.match(/[_-](\d{1,3})(?:\.[A-Za-z0-9]+)?$/);
  if (m2) {
    const n = Number(m2[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  // Pattern 3: leading `N_` — algunos modelos prefieren ordenar por
  // número al inicio (e.g. 03_PRESENTACION.PPTX). Aceptamos hasta 3
  // dígitos por si zerorelleno.
  const m3 = name.match(/^(\d{1,3})[_-]/);
  if (m3) {
    const n = Number(m3[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  return null;
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

/** True si el filename parece intro del curso (no pertenece a ninguna clase). */
export function isIntroFilename(name: string): boolean {
  return /INTRO|INTRODUCCION|PORTADA|COVER/i.test(name);
}

/**
 * True si el archivo es de uso exclusivo del docente y NO debe
 * mostrarse al estudiante en su tablero / vista de sesión. Hoy:
 *  - GUIA_DOCENTE_*.md → guion completo de la clase (incluye errores
 *    comunes, respuestas a preguntas frecuentes, etc.).
 *  - EJERCICIO_SOLUCION_*.md → solución paso a paso de un ejercicio
 *    que el estudiante debe resolver por sí mismo.
 *
 * El estudiante SÍ debe ver: PRESENTACION (slides), TALLER_PRACTICO
 * (instrucciones del laboratorio), EJERCICIO_ESTUDIANTE (enunciado
 * sin solución), INTRO_CURSO.
 *
 * El check es case-insensitive y aplica sobre el filename completo —
 * tolera variantes como "Guia Docente Clase 1 - Tema.md" después del
 * rename amigable del downloader.
 */
export function isTeacherOnlyFile(name: string): boolean {
  const upper = name.toUpperCase();
  // Solución del ejercicio: detectamos "SOLUCION" o "SOLUTION".
  if (/SOLUCION|SOLUTION/.test(upper)) return true;
  // Guía docente: "GUIA_DOCENTE", "GUIA DOCENTE", "TEACHER_GUIDE", etc.
  // Importante: NO matchear solo "GUIA" porque podríamos confundir con
  // una guía del estudiante a futuro.
  if (/GUIA[_\s-]*DOCENTE|TEACHER[_\s-]*GUIDE/.test(upper)) return true;
  return false;
}

/**
 * Agrupa archivos por clase. Primero intenta detectar el número de
 * clase con `classNumberFromFilename`. Si NINGÚN archivo lo trae y el
 * curso declara `nClasses > 0`, hace fallback: separa los intro
 * (matchean `isIntroFilename`) y distribuye el resto en orden, en
 * `nClasses` buckets de tamaño parejo. Esto recupera el caso del modelo
 * que ignora el contrato `_CLASE_<N>` y devuelve filenames planos
 * (PRESENTACION.PPTX, GUIA_DOCENTE.MD, TALLER.MD repetidos).
 *
 * Devuelve `{ intro, byClass }` donde `byClass` es Map<classN, files[]>.
 */
export function groupFilesByClass(
  files: ContentFile[],
  nClasses: number | null,
): { intro: ContentFile[]; byClass: Map<number, ContentFile[]> } {
  const intro: ContentFile[] = [];
  const byClass = new Map<number, ContentFile[]>();

  // Intento 1: detección por filename.
  let detectedAny = false;
  for (const f of files) {
    const n = classNumberFromFilename(f.name);
    if (n != null) {
      detectedAny = true;
      const arr = byClass.get(n) ?? [];
      arr.push(f);
      byClass.set(n, arr);
    } else {
      intro.push(f);
    }
  }
  if (detectedAny) return { intro, byClass };

  // Fallback: el modelo no respetó el sufijo. Si el curso declara N
  // clases, separamos intro (heurística por nombre) y partimos el
  // resto en N buckets respetando el orden de llegada.
  if (!nClasses || nClasses <= 0) return { intro, byClass };

  const introFiles: ContentFile[] = [];
  const rest: ContentFile[] = [];
  for (const f of files) {
    if (isIntroFilename(f.name)) introFiles.push(f);
    else rest.push(f);
  }
  if (rest.length === 0) return { intro: introFiles, byClass };

  const perClass = Math.max(1, Math.round(rest.length / nClasses));
  const fbByClass = new Map<number, ContentFile[]>();
  for (let i = 0; i < rest.length; i++) {
    const cls = Math.min(nClasses, Math.floor(i / perClass) + 1);
    const arr = fbByClass.get(cls) ?? [];
    arr.push(rest[i]);
    fbByClass.set(cls, arr);
  }
  return { intro: introFiles, byClass: fbByClass };
}

/**
 * Concatena los `body` de los archivos relevantes con un encabezado
 * que identifica cada uno (para que el modelo distinga slides vs guía
 * vs taller). Si `classNumbers` está dado, filtra a archivos cuyo nombre
 * contenga `_CLASE_<N>` para alguno de esos números. `classNumber`
 * (singular) sigue siendo aceptado por compatibilidad con el caller
 * antiguo. Si no hay match exacto, cae a "todos los archivos" para no
 * devolver string vacío.
 *
 * El resultado se trunca a `maxChars` para no inflar la descripción
 * de la evaluación creada (las descripciones largas se truncan en la
 * UI y aumentan el costo del prompt al generar preguntas).
 */
export function extractContentText(
  files: ContentFile[],
  options: { classNumber?: number | null; classNumbers?: number[]; maxChars?: number } = {},
): string {
  const { classNumber = null, classNumbers, maxChars = 8000 } = options;

  let relevant = files;
  if (classNumbers && classNumbers.length > 0) {
    const set = new Set(classNumbers);
    const filtered = files.filter((f) => {
      const n = classNumberFromFilename(f.name);
      return n != null && set.has(n);
    });
    if (filtered.length > 0) relevant = filtered;
  } else if (classNumber != null) {
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

/**
 * Variante que recibe el bucket de archivos ya agrupados, sin intentar
 * re-detectar el classNumber desde el filename. Util cuando el
 * agrupamiento se hizo por orden (fallback) porque los nombres no
 * tenian sufijo CLASE_N. Misma heuristica que extractClassTitle.
 */
export function extractClassTitleFromBucket(files: ContentFile[]): string | null {
  for (const f of files) {
    if (!f.body) continue;
    const lines = f.body.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("#")) {
        const cleaned = t
          .replace(/^#+\s*/, "")
          .replace(/^clase\s+\d+\s*[:\-—]\s*/i, "")
          .trim();
        if (cleaned) return cleaned.slice(0, 120);
      }
      const cleaned = t.replace(/^(t[ií]tulo|title)\s*:\s*/i, "").trim();
      return cleaned.slice(0, 120);
    }
  }
  return null;
}

/**
 * Intenta extraer el título/tema de una clase a partir del primer
 * heading o primera línea con sustancia que aparece en el body de
 * cualquier archivo de esa clase. La heurística:
 *   1) Primer línea que empieza con `#` (markdown heading) — quita los
 *      `#` y un prefijo redundante "Clase N:" si lo trae.
 *   2) Si no, primera línea no vacía como fallback (truncada).
 * Devuelve null si ningún archivo de la clase tiene body.
 */
export function extractClassTitle(files: ContentFile[], classNumber: number): string | null {
  const filtered = files.filter((f) => classNumberFromFilename(f.name) === classNumber);
  for (const f of filtered) {
    if (!f.body) continue;
    const lines = f.body.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("#")) {
        const cleaned = t
          .replace(/^#+\s*/, "")
          .replace(/^clase\s+\d+\s*[:\-—]\s*/i, "")
          .trim();
        if (cleaned) return cleaned.slice(0, 120);
      }
      // Fallback: primera línea con sustancia. No la usamos si arranca
      // con "TITULO:" o similar de plantilla — cortamos desde el ":".
      const cleaned = t.replace(/^(t[ií]tulo|title)\s*:\s*/i, "").trim();
      return cleaned.slice(0, 120);
    }
  }
  return null;
}
