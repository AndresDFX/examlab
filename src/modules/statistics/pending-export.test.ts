import { describe, it, expect } from "vitest";
import { buildPendingReportHtml, type PendingReportOptions } from "./pending-export";
import type { StudentPendingRow } from "./pending-students";

const labels: PendingReportOptions["labels"] = {
  title: "Pendientes por estudiante",
  scope: "Alcance",
  generatedAt: "Generado",
  colStudent: "Estudiante",
  colCourses: "Cursos",
  colFirma: "Firma",
  colEncuesta: "Encuesta",
  colExamen: "Examen",
  colTaller: "Taller",
  colProyecto: "Proyecto",
  colTotal: "Total",
  upToDate: "Al día",
  excludedNote: (n) => `Se excluyeron ${n} estudiantes.`,
  fieldLabels: {
    codigo: "Código",
    documento: "Documento",
    institutional_email: "Correo institucional",
    personal_email: "Correo personal",
    programa: "Programa",
  },
  courseSectionTitle: (course) => `Curso: ${course}`,
};

const opts: PendingReportOptions = {
  brand: { institucion: "Instituto Demo", logoUrl: "https://cdn.example/logo.png" },
  scopeLabel: "Curso X",
  generatedAtLabel: "30 sep 2026, 14:30",
  labels,
};

function row(over: Partial<StudentPendingRow>): StudentPendingRow {
  return {
    userId: "u",
    name: "Ada Lovelace",
    courses: ["Curso X"],
    firma: 0,
    encuesta: 0,
    examen: 0,
    taller: 0,
    proyecto: 0,
    total: 0,
    byCourse: [],
    ...over,
  };
}

describe("buildPendingReportHtml", () => {
  it("NO usa <th>/<thead> — el exportador a .docx solo lee <td>", () => {
    const html = buildPendingReportHtml([row({})], 0, opts);
    // El bug original: la cabecera iba en <thead><th>, que html-to-docx descarta,
    // dejando el Word SIN fila de encabezado.
    expect(html).not.toMatch(/<th\b/i);
    expect(html).not.toMatch(/<thead\b/i);
  });

  it("la cabecera es la primera fila de <td><strong> con el nombre de cada columna", () => {
    const html = buildPendingReportHtml([row({})], 0, opts);
    for (const c of ["Estudiante", "Cursos", "Firma", "Encuesta", "Examen", "Taller", "Proyecto", "Total"]) {
      expect(html).toContain(`<strong>${c}</strong>`);
    }
  });

  it("las celdas llevan borde inline (sin él la tabla del Word sale sin líneas)", () => {
    const html = buildPendingReportHtml([row({ examen: 2, total: 2 })], 0, opts);
    expect(html).toMatch(/border:1px solid/i);
  });

  it("marca 'Al día' cuando total es 0 y el conteo cuando hay pendientes", () => {
    const alDia = buildPendingReportHtml([row({ total: 0 })], 0, opts);
    expect(alDia).toContain("Al día");
    const conPendiente = buildPendingReportHtml(
      [row({ examen: 3, total: 3 })],
      0,
      opts,
    );
    // El total 3 aparece como celda final; las columnas vacías caen a "—".
    expect(conPendiente).toContain(">3<");
    expect(conPendiente).toContain(">—<");
  });

  it("nota de exclusión solo cuando se excluyó a alguien", () => {
    expect(buildPendingReportHtml([row({})], 0, opts)).not.toContain("Se excluyeron");
    expect(buildPendingReportHtml([row({})], 2, opts)).toContain("Se excluyeron 2 estudiantes.");
  });

  it("escapa el nombre del estudiante (no inyecta HTML)", () => {
    const html = buildPendingReportHtml([row({ name: "<b>x</b>" })], 0, opts);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("agrega columnas dinámicas por cada campo opcional elegido", () => {
    const html = buildPendingReportHtml(
      [row({ codigo: "202412345", institutionalEmail: "ada@uni.edu" })],
      0,
      { ...opts, extraFields: ["codigo", "institutional_email"] },
    );
    expect(html).toContain("<strong>Código</strong>");
    expect(html).toContain("<strong>Correo institucional</strong>");
    expect(html).toContain(">202412345<");
    expect(html).toContain(">ada@uni.edu<");
    // Sin elegir el campo, no aparece su columna.
    expect(html).not.toContain("<strong>Documento</strong>");
  });

  it("incluye el logo remoto como <img> (lo embebe inlineRemoteImages en la descarga)", () => {
    const html = buildPendingReportHtml([row({})], 0, opts);
    expect(html).toContain('src="https://cdn.example/logo.png"');
    expect(html).toMatch(/@page[^}]*landscape/i);
  });

  describe("alcance de 1 solo curso", () => {
    it("mantiene la tabla plana con columna Cursos aunque se pase `courses`", () => {
      const html = buildPendingReportHtml([row({})], 0, { ...opts, courses: [{ id: "c1", name: "Curso X" }] });
      expect(html).toContain("<strong>Cursos</strong>");
      expect(html).not.toContain("Curso: Curso X");
      // Una sola tabla de DATOS (más la del <header>, que ya existía antes).
      expect((html.match(/<table>/g) ?? []).length).toBe(1);
    });
  });

  describe("alcance multi-curso", () => {
    const c1 = { id: "c1", name: "Álgebra" };
    const c2 = { id: "c2", name: "Bases de datos" };
    const ana = row({
      userId: "u1",
      name: "Ana",
      byCourse: [
        { courseId: "c1", courseName: "Álgebra", firma: 0, encuesta: 0, examen: 2, taller: 0, proyecto: 0, total: 2 },
        { courseId: "c2", courseName: "Bases de datos", firma: 0, encuesta: 0, examen: 0, taller: 0, proyecto: 0, total: 0 },
      ],
      total: 2,
    });
    const beto = row({
      userId: "u2",
      name: "Beto",
      byCourse: [{ courseId: "c1", courseName: "Álgebra", firma: 1, encuesta: 0, examen: 0, taller: 0, proyecto: 0, total: 1 }],
      total: 1,
    });

    it("arma una sección por curso, sin la columna Cursos", () => {
      const html = buildPendingReportHtml([ana, beto], 0, { ...opts, courses: [c1, c2] });
      expect(html).toContain("Curso: Álgebra");
      expect(html).toContain("Curso: Bases de datos");
      expect(html).not.toContain("<strong>Cursos</strong>");
    });

    it("cada sección lista solo a los matriculados en ESE curso, con sus conteos de ESE curso", () => {
      const html = buildPendingReportHtml([ana, beto], 0, { ...opts, courses: [c1, c2] });
      // Álgebra: Ana (2 exámenes) y Beto (1 firma) — ambos aparecen.
      const algebraIdx = html.indexOf("Curso: Álgebra");
      const bdIdx = html.indexOf("Curso: Bases de datos");
      const algebraSection = html.slice(algebraIdx, bdIdx);
      expect(algebraSection).toContain("Ana");
      expect(algebraSection).toContain("Beto");
      // Bases de datos: solo Ana está matriculada (Beto no tiene entrada en byCourse para c2).
      const bdSection = html.slice(bdIdx);
      expect(bdSection).toContain("Ana");
      expect(bdSection).not.toContain("Beto");
      // Ana está "Al día" en Bases de datos (0 pendientes en ESE curso).
      expect(bdSection).toContain("Al día");
    });

    it("salto de página entre secciones, pero no antes de la primera", () => {
      const html = buildPendingReportHtml([ana, beto], 0, { ...opts, courses: [c1, c2] });
      const breaks = (html.match(/examlab-page-break/g) ?? []).length;
      // 1 en la regla CSS + 1 marcador antes de la 2ª sección (ninguno antes de la 1ª).
      expect(breaks).toBe(2);
      expect(html.indexOf("examlab-page-break")).toBeLessThan(html.indexOf("Curso: Álgebra"));
    });
  });
});
