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
import type { StudentExtraField, StudentPendingRow } from "./pending-students";

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
export function buildPendingReportHtml(
  rows: readonly StudentPendingRow[],
  excludedCount: number,
  opts: PendingReportOptions,
): string {
  const { brand, labels, extraFields = [] } = opts;
  const logoImg = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" style="height:48px;max-width:220px;object-fit:contain" />`
    : "";

  // El exportador a .docx (`html-to-docx.ts`, `tableToWml`) SOLO lee celdas
  // <td> y toma los anchos de columna del PRIMER <tr>; el borde de cada celda
  // sale de su `style="border:..."`. Por eso NO se usan <thead>/<th> (los
  // descartaría y el Word saldría SIN fila de encabezado) — la cabecera es la
  // primera fila de <td> en negrita, y todas las celdas llevan el borde inline.
  const BORDE = "border:1px solid #cccccc;padding:4px 6px";
  const centro = `${BORDE};text-align:center`;
  const cabecera = (w: string) => `${BORDE};width:${w};background-color:#f1f5f9`;
  const cabeceraCentro = (w: string) => `${cabecera(w)};text-align:center`;

  // Las 6 columnas numéricas se quedan con un ancho fijo; el resto (nombre +
  // campos opcionales elegidos + cursos) se reparte lo que sobra en partes
  // iguales — así agregar/quitar un campo no exige retocar porcentajes a mano.
  const METRIC_COLS: Array<{ label: string; w: number }> = [
    { label: labels.colFirma, w: 9 },
    { label: labels.colEncuesta, w: 10 },
    { label: labels.colExamen, w: 9 },
    { label: labels.colTaller, w: 9 },
    { label: labels.colProyecto, w: 10 },
    { label: labels.colTotal, w: 9 },
  ];
  const metricWidth = METRIC_COLS.reduce((s, c) => s + c.w, 0);
  const textColsCount = 2 + extraFields.length; // nombre + cursos + opcionales
  const textWidth = (100 - metricWidth) / textColsCount;

  const headRow = `<tr>
    <td style="${cabecera(`${textWidth}%`)}"><strong>${escapeHtml(labels.colStudent)}</strong></td>
    ${extraFields
      .map(
        (f) =>
          `<td style="${cabecera(`${textWidth}%`)}"><strong>${escapeHtml(labels.fieldLabels[f])}</strong></td>`,
      )
      .join("")}
    <td style="${cabecera(`${textWidth}%`)}"><strong>${escapeHtml(labels.colCourses)}</strong></td>
    ${METRIC_COLS.map(
      (c) => `<td style="${cabeceraCentro(`${c.w}%`)}"><strong>${escapeHtml(c.label)}</strong></td>`,
    ).join("")}
  </tr>`;

  const bodyRows = rows
    .map((r) => {
      const upToDate = r.total === 0;
      return `<tr>
        <td style="${BORDE}">${escapeHtml(r.name)}</td>
        ${extraFields.map((f) => `<td style="${BORDE}">${escapeHtml(EXTRA_FIELD_GETTERS[f](r))}</td>`).join("")}
        <td style="${BORDE}">${escapeHtml(r.courses.join(", ") || "—")}</td>
        <td style="${centro}">${countCell(r.firma)}</td>
        <td style="${centro}">${countCell(r.encuesta)}</td>
        <td style="${centro}">${countCell(r.examen)}</td>
        <td style="${centro}">${countCell(r.taller)}</td>
        <td style="${centro}">${countCell(r.proyecto)}</td>
        <td style="${centro}">${upToDate ? escapeHtml(labels.upToDate) : String(r.total)}</td>
      </tr>`;
    })
    .join("");

  const excludedNote =
    excludedCount > 0 ? `<p><em>${escapeHtml(labels.excludedNote(excludedCount))}</em></p>` : "";

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>@page { size: A4 landscape; margin: 18mm; }</style>
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
  <table>${headRow}${bodyRows}</table>
</main>
<footer><p>${escapeHtml(brand.institucion || "")}</p></footer>
</body></html>`;
}
