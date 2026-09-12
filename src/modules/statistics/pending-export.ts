/**
 * Informe exportable de "Pendientes por estudiante" (.docx).
 *
 * Reusa el pipeline artesanal de `src/modules/reports/` (OOXML a mano vía
 * `fflate`, sin la librería `docx` — no está en el lockfile): esta función
 * arma el HTML COMPUESTO (`<header>`/`<main>`) que `downloadReportAsWord`
 * convierte a `.docx` real. El logo del `<header>` se resuelve como URL; la
 * conversión a data URI para poder embeberse en el .docx la hace
 * `inlineRemoteImages` dentro de `downloadReportAsWord`, no acá.
 *
 * A diferencia de la tabla en pantalla (que solo lista estudiantes CON
 * pendiente), el informe muestra el universo COMPLETO del alcance: cada fila
 * dice qué le falta, o "Al día" si no le falta nada — por eso consume
 * `StudentPendingRow[]` de `loadAllStudentsPending`, no de `loadPendingStudents`.
 */
import { PENDING_KINDS, type PendingKind, type StudentExtraField, type StudentPendingRow } from "./pending-students";

/** Escape mínimo para interpolar texto de usuario/DB en el HTML del informe. */
function escapeHtml(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PendingReportBrand {
  institucion: string;
  logoUrl: string | null;
}

export interface PendingReportOptions {
  brand: PendingReportBrand;
  /** Cursos del alcance (para el subtítulo: "Curso X" o "N cursos — periodo Y"). */
  scopeLabel: string;
  generatedAtLabel: string;
  /** Campos de `profiles` que el docente eligió sumar como columna, además
   *  del nombre (que siempre se muestra). Vacío = comportamiento previo. */
  extraFields?: readonly StudentExtraField[];
  /**
   * Cursos del alcance, en el orden en que deben aparecer las secciones.
   *
   * Con 0 o 1 curso, el informe es la tabla plana única de siempre (con
   * columna "Cursos"). Con 2+, arma UNA SECCIÓN POR CURSO — cada una con el
   * nombre del curso como encabezado y las MISMAS columnas que la tabla en
   * pantalla del panel (Estudiante, Firma, Encuesta, Examen, Taller,
   * Proyecto, Total), pero SIN la columna "Cursos": el curso ya es el título
   * de la sección. Cada sección lista a TODOS los matriculados en ESE curso
   * puntual (`row.byCourse`), incluidos los que ahí están al día — por eso
   * `aggregateAllStudents` puebla `byCourse` para TODA la matrícula, no solo
   * los cursos con pendiente.
   */
  courses?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * En modo multi-curso, cada sección lista por defecto a TODO matriculado en
   * ese curso, incluidos los que ahí están "Al día" (útil para ver el roster
   * completo). El docente puede pedir lo contrario: solo listar, en cada
   * sección, a quien realmente tiene algo pendiente EN ESE curso puntual —
   * un estudiante "al día" en un curso se OMITE de esa sección aunque tenga
   * pendientes en otro curso del informe (así "Excluir al día" del diálogo
   * deja de sentirse ignorado cuando el estudiante reaparece solo en la
   * sección donde ya no debe nada). Sin efecto en el modo de 1 solo curso.
   */
  hideUpToDatePerCourse?: boolean;
  /** Tipos de pendiente a incluir como columna (filtro de sesión — ver
   *  `filterItemsByKind`). Por defecto los 5 (comportamiento previo). Cuando
   *  el docente excluye un tipo (ej. Talleres) para el alcance actual, la
   *  columna correspondiente desaparece del informe entero — mostrarla llena
   *  de "—" sería más confuso que quitarla. `Total` SIEMPRE se muestra: ya
   *  refleja solo los tipos incluidos porque las filas llegan pre-filtradas. */
  includeKinds?: ReadonlySet<PendingKind>;
  /** Textos ya traducidos (el módulo es puro, no importa i18n). */
  labels: {
    title: string;
    scope: string;
    generatedAt: string;
    colStudent: string;
    colCourses: string;
    colFirma: string;
    colEncuesta: string;
    colExamen: string;
    colTaller: string;
    colProyecto: string;
    colTotal: string;
    upToDate: string;
    excludedNote: (n: number) => string;
    /** Etiqueta de columna por cada campo opcional de `STUDENT_EXTRA_FIELDS`. */
    fieldLabels: Record<StudentExtraField, string>;
    /** Encabezado de cada sección en modo multi-curso: "Curso: <nombre>". */
    courseSectionTitle: (courseName: string) => string;
    /** Mensaje cuando `hideUpToDatePerCourse` deja una sección sin filas. */
    courseSectionAllUpToDate: string;
  };
}

/** Getter de cada campo opcional sobre la fila — un único lugar que sabe leer
 *  `StudentPendingRow` para que `buildPendingReportHtml` no repita el mapeo. */
const EXTRA_FIELD_GETTERS: Record<StudentExtraField, (r: StudentPendingRow) => string> = {
  codigo: (r) => r.codigo || "—",
  documento: (r) => r.documento || "—",
  institutional_email: (r) => r.institutionalEmail || "—",
  personal_email: (r) => r.personalEmail || "—",
  programa: (r) => r.programa || "—",
};

/** Celda de conteo: "—" si 0, el número si hay pendiente (mismo criterio que
 *  la tabla en pantalla, `CountCell`). */
function countCell(n: number): string {
  return n > 0 ? String(n) : "—";
}

/**
 * PURO: arma el HTML compuesto del informe a partir de las filas YA filtradas
 * por el caller (universo completo menos los estudiantes excluidos).
 */
// El exportador a .docx (`html-to-docx.ts`, `tableToWml`) SOLO lee celdas
// <td> y toma los anchos de columna del PRIMER <tr>; el borde de cada celda
// sale de su `style="border:..."`. Por eso NO se usan <thead>/<th> (los
// descartaría y el Word saldría SIN fila de encabezado) — la cabecera es la
// primera fila de <td> en negrita, y todas las celdas llevan el borde inline.
//
// El padding es COMPACTO a propósito (fila de tabla normal, no una celda
// inflada): el .docx fuerza `wordWrap:0` (parte palabras carácter a
// carácter, ver STYLES_XML) para que un correo largo no desborde una
// columna angosta — pero eso mismo convierte una columna DEMASIADO angosta
// en una fila gigantesca (cada palabra se corta en 2-3 letras por línea).
// Por eso el ancho de columna no se reparte en partes iguales más abajo.
const BORDE = "border:1px solid #cccccc;padding:3px 5px";
const CENTRO = `${BORDE};text-align:center`;
const cabecera = (w: number) => `${BORDE};width:${w.toFixed(2)}%;background-color:#f1f5f9`;
const cabeceraCentro = (w: number) => `${cabecera(w)};text-align:center`;

/** Las 6 columnas numéricas llevan un ancho fijo y angosto (son 1-2 dígitos
 *  o "—"). El resto del ancho se reparte por PESO, no en partes iguales:
 *  nombre y cursos suelen tener el contenido más largo, mientras que un
 *  código o un documento entran en pocos caracteres. Repartir parejo
 *  angostaba TODAS las columnas de texto por igual al sumar varios campos
 *  opcionales — el bug reportado de filas gigantescas venía de acá. */
function metricCols(
  labels: PendingReportOptions["labels"],
  includeKinds: ReadonlySet<PendingKind>,
): Array<{ kind: PendingKind | "total"; label: string; w: number }> {
  const all: Array<{ kind: PendingKind | "total"; label: string; w: number }> = [
    { kind: "firma", label: labels.colFirma, w: 7 },
    { kind: "encuesta", label: labels.colEncuesta, w: 8 },
    { kind: "examen", label: labels.colExamen, w: 7 },
    { kind: "taller", label: labels.colTaller, w: 7 },
    { kind: "proyecto", label: labels.colProyecto, w: 8 },
    { kind: "total", label: labels.colTotal, w: 7 },
  ];
  return all.filter((c) => c.kind === "total" || includeKinds.has(c.kind));
}

const TEXT_COL_WEIGHT: Record<"name" | "courses" | StudentExtraField, number> = {
  name: 3,
  courses: 3,
  codigo: 1.2,
  documento: 1.6,
  institutional_email: 2.4,
  personal_email: 2.4,
  programa: 1.8,
};

/** Ancho de columnas de texto (nombre + campos opcionales + "Cursos" cuando
 *  aplica), calculado por PESO sobre el espacio que dejan libre las 6
 *  columnas numéricas. `includeCourses=false` en modo sección-por-curso: ahí
 *  el curso ya es el título de la sección y sobra la columna. */
function textWidths(
  labels: PendingReportOptions["labels"],
  extraFields: readonly StudentExtraField[],
  includeCourses: boolean,
  includeKinds: ReadonlySet<PendingKind>,
): { nameWidth: number; coursesWidth: number; widthOf: (f: StudentExtraField) => number } {
  const metricWidth = metricCols(labels, includeKinds).reduce((s, c) => s + c.w, 0);
  const textRemaining = 100 - metricWidth;
  const textWeightSum =
    TEXT_COL_WEIGHT.name +
    (includeCourses ? TEXT_COL_WEIGHT.courses : 0) +
    extraFields.reduce((s, f) => s + TEXT_COL_WEIGHT[f], 0);
  const widthOfWeight = (weight: number) => (weight / textWeightSum) * textRemaining;
  return {
    nameWidth: widthOfWeight(TEXT_COL_WEIGHT.name),
    coursesWidth: includeCourses ? widthOfWeight(TEXT_COL_WEIGHT.courses) : 0,
    widthOf: (f) => widthOfWeight(TEXT_COL_WEIGHT[f]),
  };
}

/** Fila de cabecera, con o sin la columna "Cursos". */
function headRowHtml(
  labels: PendingReportOptions["labels"],
  extraFields: readonly StudentExtraField[],
  includeCourses: boolean,
  includeKinds: ReadonlySet<PendingKind>,
): string {
  const { nameWidth, coursesWidth, widthOf } = textWidths(labels, extraFields, includeCourses, includeKinds);
  return `<tr>
    <td style="${cabecera(nameWidth)}"><strong>${escapeHtml(labels.colStudent)}</strong></td>
    ${extraFields
      .map((f) => `<td style="${cabecera(widthOf(f))}"><strong>${escapeHtml(labels.fieldLabels[f])}</strong></td>`)
      .join("")}
    ${includeCourses ? `<td style="${cabecera(coursesWidth)}"><strong>${escapeHtml(labels.colCourses)}</strong></td>` : ""}
    ${metricCols(labels, includeKinds)
      .map((c) => `<td style="${cabeceraCentro(c.w)}"><strong>${escapeHtml(c.label)}</strong></td>`)
      .join("")}
  </tr>`;
}

/** Celdas comunes de una fila (nombre + campos opcionales) — compartidas por
 *  la tabla plana y por las secciones por curso. */
function commonCellsHtml(r: StudentPendingRow, extraFields: readonly StudentExtraField[]): string {
  return `<td style="${BORDE}">${escapeHtml(r.name)}</td>
    ${extraFields.map((f) => `<td style="${BORDE}">${escapeHtml(EXTRA_FIELD_GETTERS[f](r))}</td>`).join("")}`;
}

/** Las 6 celdas de conteo (firma..total), a partir de conteos crudos. */
function countCellsHtml(
  labels: PendingReportOptions["labels"],
  counts: { firma: number; encuesta: number; examen: number; taller: number; proyecto: number; total: number },
  includeKinds: ReadonlySet<PendingKind>,
): string {
  const upToDate = counts.total === 0;
  const cells = PENDING_KINDS.filter((k) => includeKinds.has(k))
    .map((k) => `<td style="${CENTRO}">${countCell(counts[k])}</td>`)
    .join("");
  return `${cells}<td style="${CENTRO}">${upToDate ? escapeHtml(labels.upToDate) : String(counts.total)}</td>`;
}

/** Tabla plana única (comportamiento previo): todos los estudiantes del
 *  alcance en una sola tabla, con la columna "Cursos". Usada cuando el
 *  alcance es de 0 o 1 curso. */
function flatTableHtml(
  rows: readonly StudentPendingRow[],
  labels: PendingReportOptions["labels"],
  extraFields: readonly StudentExtraField[],
  includeKinds: ReadonlySet<PendingKind>,
): string {
  const head = headRowHtml(labels, extraFields, true, includeKinds);
  const body = rows
    .map(
      (r) => `<tr>
        ${commonCellsHtml(r, extraFields)}
        <td style="${BORDE}">${escapeHtml(r.courses.join(", ") || "—")}</td>
        ${countCellsHtml(labels, r, includeKinds)}
      </tr>`,
    )
    .join("");
  return `<table>${head}${body}</table>`;
}

/** UNA sección por curso: encabezado con el nombre del curso + tabla con las
 *  mismas columnas de la tabla en pantalla (sin "Cursos" — el título de la
 *  sección ya lo dice). Lista a TODOS los matriculados en ESE curso puntual
 *  (`row.byCourse`), incluidos los que ahí están al día. Un estudiante que no
 *  figura en `byCourse` para este curso no está matriculado en él y no
 *  aparece en la sección. */
function courseSectionHtml(
  course: { id: string; name: string },
  rows: readonly StudentPendingRow[],
  labels: PendingReportOptions["labels"],
  extraFields: readonly StudentExtraField[],
  isFirst: boolean,
  hideUpToDate: boolean,
  includeKinds: ReadonlySet<PendingKind>,
): string {
  const head = headRowHtml(labels, extraFields, false, includeKinds);
  const enrolled = rows
    .map((r) => ({ r, cc: r.byCourse.find((c) => c.courseId === course.id) }))
    .filter((x): x is { r: StudentPendingRow; cc: NonNullable<typeof x.cc> } => !!x.cc)
    .filter((x) => !hideUpToDate || x.cc.total > 0)
    .sort((a, b) => a.r.name.localeCompare(b.r.name, "es-CO", { sensitivity: "base" }));
  const body = enrolled
    .map(
      ({ r, cc }) => `<tr>
        ${commonCellsHtml(r, extraFields)}
        ${countCellsHtml(labels, cc, includeKinds)}
      </tr>`,
    )
    .join("");
  // Salto de página REAL en .docx (`.examlab-page-break` → `<w:br type="page">`
  // en html-to-docx.ts) y en el PDF/print (regla CSS de abajo) — un solo marcador
  // sirve para los dos formatos. No se emite antes de la primera sección: eso
  // dejaría una página en blanco al inicio del informe.
  const pageBreak = isFirst ? "" : `<div class="examlab-page-break"></div>`;
  // Con `hideUpToDate` puede quedar una sección sin filas (todos al día en
  // ESE curso puntual, aunque el informe entero no esté vacío) — un <table>
  // con solo la cabecera se lee como un error de generación, no como "nadie
  // debe nada acá".
  const tableOrEmpty =
    enrolled.length > 0
      ? `<table>${head}${body}</table>`
      : `<p><em>${escapeHtml(labels.courseSectionAllUpToDate)}</em></p>`;
  return `${pageBreak}<h2>${escapeHtml(labels.courseSectionTitle(course.name))}</h2>
  ${tableOrEmpty}`;
}

/**
 * PURO: arma el HTML compuesto del informe a partir de las filas YA filtradas
 * por el caller (universo completo menos los estudiantes excluidos).
 */
export function buildPendingReportHtml(
  rows: readonly StudentPendingRow[],
  excludedCount: number,
  opts: PendingReportOptions,
): string {
  const {
    brand,
    labels,
    extraFields = [],
    courses = [],
    hideUpToDatePerCourse = false,
    includeKinds = new Set(PENDING_KINDS),
  } = opts;
  const logoImg = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" style="height:48px;max-width:220px;object-fit:contain" />`
    : "";

  // Multi-curso ⇒ una sección por curso (mismas columnas de la tabla en
  // pantalla, sin "Cursos"). Con 0 o 1 curso en el alcance, se mantiene la
  // tabla plana única de siempre — un solo curso no necesita separarse de sí
  // mismo, y la columna "Cursos" ahí siempre dice lo mismo.
  const tablesHtml =
    courses.length > 1
      ? courses
          .map((c, i) =>
            courseSectionHtml(c, rows, labels, extraFields, i === 0, hideUpToDatePerCourse, includeKinds),
          )
          .join("\n")
      : flatTableHtml(rows, labels, extraFields, includeKinds);

  const excludedNote =
    excludedCount > 0 ? `<p><em>${escapeHtml(labels.excludedNote(excludedCount))}</em></p>` : "";

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: A4 landscape; margin: 18mm; }
  /* Solo afecta al PREVIEW/PDF (impreso vía window.print) — el .docx ignora
     este bloque (html-to-docx.ts solo lee el atributo style de cada elemento,
     no la cascada de <style>) y ya sale compacto por el ancho de columna. */
  table { font-size: 9pt; border-collapse: collapse; width: 100%; }
  td { line-height: 1.25; }
  h2 { font-size: 12pt; margin: 14px 0 6px; }
  /* Una sección por curso cae en su propia página al imprimir/PDF; el mismo
     marcador produce, ademas, un salto de pagina real en el .docx. */
  .examlab-page-break { page-break-before: always; }
</style>
</head>
<body>
<header>
  <table style="width:100%"><tr>
    <td style="width:60px">${logoImg}</td>
    <td><strong>${escapeHtml(brand.institucion || "")}</strong><br/>${escapeHtml(labels.title)}</td>
  </tr></table>
</header>
<main>
  <h1>${escapeHtml(labels.title)}</h1>
  <p><strong>${escapeHtml(labels.scope)}:</strong> ${escapeHtml(opts.scopeLabel)}</p>
  <p><strong>${escapeHtml(labels.generatedAt)}:</strong> ${escapeHtml(opts.generatedAtLabel)}</p>
  ${excludedNote}
  ${tablesHtml}
</main>
<footer><p>${escapeHtml(brand.institucion || "")}</p></footer>
</body></html>`;
}
