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
import type { StudentPendingRow } from "./pending-students";

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
  };
}

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
  const { brand, labels } = opts;
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

  const headRow = `<tr>
    <td style="${cabecera("22%")}"><strong>${escapeHtml(labels.colStudent)}</strong></td>
    <td style="${cabecera("22%")}"><strong>${escapeHtml(labels.colCourses)}</strong></td>
    <td style="${cabeceraCentro("9%")}"><strong>${escapeHtml(labels.colFirma)}</strong></td>
    <td style="${cabeceraCentro("10%")}"><strong>${escapeHtml(labels.colEncuesta)}</strong></td>
    <td style="${cabeceraCentro("9%")}"><strong>${escapeHtml(labels.colExamen)}</strong></td>
    <td style="${cabeceraCentro("9%")}"><strong>${escapeHtml(labels.colTaller)}</strong></td>
    <td style="${cabeceraCentro("10%")}"><strong>${escapeHtml(labels.colProyecto)}</strong></td>
    <td style="${cabeceraCentro("9%")}"><strong>${escapeHtml(labels.colTotal)}</strong></td>
  </tr>`;

  const bodyRows = rows
    .map((r) => {
      const upToDate = r.total === 0;
      return `<tr>
        <td style="${BORDE}">${escapeHtml(r.name)}</td>
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
