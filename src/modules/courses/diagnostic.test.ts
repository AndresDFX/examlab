/**
 * Tests del helper de Diagnóstico del curso.
 *
 * Los helpers son puros (sin React, sin Supabase) — testamos la lógica
 * de clasificación de celdas, el resumen agregado y los conteos de
 * asistencia sin necesidad de jsdom.
 */
import { describe, expect, it } from "vitest";
import {
  summarizePendingGrades,
  summarizeMatrix,
  summarizeAttendance,
  summarizeCohortCoverage,
  summarizeWeightCoverage,
  diagCellSeverity,
  diagCellStatusLabel,
  type DiagItem,
  type DiagStudent,
  type DiagSubmission,
  type DiagCut,
  type DiagWeightedItem,
} from "./diagnostic";

// ── Fixtures compartidas ──────────────────────────────────────────────
const ana: DiagStudent = {
  id: "u-ana",
  full_name: "Ana",
  institutional_email: "ana@uni.edu",
};
const beto: DiagStudent = {
  id: "u-beto",
  full_name: "Beto",
  institutional_email: "beto@uni.edu",
};

const examen: DiagItem = { id: "ex-1", title: "Parcial 1", kind: "exam" };
const taller: DiagItem = { id: "ws-1", title: "Taller 1", kind: "workshop" };
const proyecto: DiagItem = { id: "pr-1", title: "Proyecto 1", kind: "project" };

// ── summarizePendingGrades ────────────────────────────────────────────
describe("summarizePendingGrades", () => {
  it("estudiante sin submission → sin_entregar", () => {
    const rows = summarizePendingGrades([ana], [], [examen]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sin_entregar");
    expect(rows[0].student.id).toBe("u-ana");
    expect(rows[0].item.id).toBe("ex-1");
  });

  it("submission entregada sin nota → entregado_sin_calificar", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "ex-1",
      item_kind: "exam",
      status: "entregado",
      has_final_grade: false,
    };
    const rows = summarizePendingGrades([ana], [sub], [examen]);
    expect(rows[0].status).toBe("entregado_sin_calificar");
  });

  it("submission con nota persistida → calificado", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "ex-1",
      item_kind: "exam",
      status: "calificado",
      has_final_grade: true,
    };
    const rows = summarizePendingGrades([ana], [sub], [examen]);
    expect(rows[0].status).toBe("calificado");
  });

  it("submission con job IA failed → error_ia (gana al estado calificado)", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "ex-1",
      item_kind: "exam",
      status: "calificado",
      has_final_grade: true,
    };
    const failedRefs = new Set(["u-ana::exam::ex-1"]);
    const rows = summarizePendingGrades([ana], [sub], [examen], failedRefs);
    expect(rows[0].status).toBe("error_ia");
    expect(rows[0].hasAiError).toBe(true);
  });

  it("matriz NxM: 2 estudiantes × 3 items = 6 filas", () => {
    const rows = summarizePendingGrades([ana, beto], [], [examen, taller, proyecto]);
    expect(rows).toHaveLength(6);
    // Todas sin_entregar porque no hay submissions.
    expect(rows.every((r) => r.status === "sin_entregar")).toBe(true);
  });

  it("matriz mixta: 2 estudiantes × 2 items con distintos estados", () => {
    const subs: DiagSubmission[] = [
      // Ana entregó el examen pero no está calificado.
      {
        user_id: "u-ana",
        item_id: "ex-1",
        item_kind: "exam",
        status: "entregado",
        has_final_grade: false,
      },
      // Ana entregó el taller y está calificado.
      {
        user_id: "u-ana",
        item_id: "ws-1",
        item_kind: "workshop",
        status: "calificado",
        has_final_grade: true,
      },
      // Beto entregó el examen — falló la IA.
      {
        user_id: "u-beto",
        item_id: "ex-1",
        item_kind: "exam",
        status: "entregado",
        has_final_grade: false,
      },
      // Beto NO entregó el taller.
    ];
    const failedRefs = new Set(["u-beto::exam::ex-1"]);
    const rows = summarizePendingGrades([ana, beto], subs, [examen, taller], failedRefs);
    expect(rows).toHaveLength(4);
    const byKey = new Map(rows.map((r) => [`${r.student.id}::${r.item.id}`, r.status]));
    expect(byKey.get("u-ana::ex-1")).toBe("entregado_sin_calificar");
    expect(byKey.get("u-ana::ws-1")).toBe("calificado");
    expect(byKey.get("u-beto::ex-1")).toBe("error_ia");
    expect(byKey.get("u-beto::ws-1")).toBe("sin_entregar");
  });

  it("kinds distintos no se mezclan: una submission de workshop con mismo id no clasifica un examen", () => {
    // Edge case: si dos items distintos (un exam y un workshop) tuvieran
    // el mismo id (raro pero posible — UUIDs colisionan teóricamente),
    // la indexación por kind+id+user los mantiene separados.
    const subs: DiagSubmission[] = [
      {
        user_id: "u-ana",
        item_id: "shared-id",
        item_kind: "workshop",
        status: "calificado",
        has_final_grade: true,
      },
    ];
    const examShared: DiagItem = { id: "shared-id", title: "Exam compartido", kind: "exam" };
    const wsShared: DiagItem = { id: "shared-id", title: "Workshop compartido", kind: "workshop" };
    const rows = summarizePendingGrades([ana], subs, [examShared, wsShared]);
    const examRow = rows.find((r) => r.item.kind === "exam");
    const wsRow = rows.find((r) => r.item.kind === "workshop");
    expect(examRow?.status).toBe("sin_entregar");
    expect(wsRow?.status).toBe("calificado");
  });
});

// ── summarizeMatrix ───────────────────────────────────────────────────
describe("summarizeMatrix", () => {
  it("cuenta correctamente cada bucket", () => {
    const subs: DiagSubmission[] = [
      {
        user_id: "u-ana",
        item_id: "ex-1",
        item_kind: "exam",
        status: "entregado",
        has_final_grade: false,
      },
      {
        user_id: "u-ana",
        item_id: "ws-1",
        item_kind: "workshop",
        status: "calificado",
        has_final_grade: true,
      },
    ];
    const failedRefs = new Set(["u-beto::exam::ex-1"]);
    const rows = summarizePendingGrades(
      [ana, beto],
      [
        ...subs,
        {
          user_id: "u-beto",
          item_id: "ex-1",
          item_kind: "exam",
          status: "entregado",
          has_final_grade: false,
        },
      ],
      [examen, taller],
      failedRefs,
    );
    const sm = summarizeMatrix(rows);
    expect(sm.totalCells).toBe(4);
    expect(sm.entregadoSinCalificar).toBe(1);
    expect(sm.calificado).toBe(1);
    expect(sm.errorIa).toBe(1);
    expect(sm.sinEntregar).toBe(1);
  });

  it("matriz vacía da todos los conteos a 0", () => {
    const sm = summarizeMatrix([]);
    expect(sm.totalCells).toBe(0);
    expect(sm.sinEntregar).toBe(0);
    expect(sm.errorIa).toBe(0);
  });
});

// ── summarizeAttendance ───────────────────────────────────────────────
describe("summarizeAttendance", () => {
  it("cuenta presentes / ausentes / pendientes correctamente", () => {
    const sessions = [{ id: "s-1", session_date: "2026-06-10", title: "Clase 1" }];
    const records = [
      { session_id: "s-1", user_id: "u-1", status: "presente" },
      { session_id: "s-1", user_id: "u-2", status: "ausente" },
    ];
    // 5 matriculados, 2 con registro → 3 pendientes.
    const out = summarizeAttendance(sessions, records, 5);
    expect(out).toHaveLength(1);
    expect(out[0].present).toBe(1);
    expect(out[0].absent).toBe(1);
    expect(out[0].pending).toBe(3);
  });

  it("estados raros (tarde / excusado / null) no cuentan", () => {
    const sessions = [{ id: "s-1", session_date: "2026-06-10", title: null }];
    const records = [
      { session_id: "s-1", user_id: "u-1", status: "tarde" },
      { session_id: "s-1", user_id: "u-2", status: "excusado" },
      { session_id: "s-1", user_id: "u-3", status: null },
    ];
    // 3 records, todos con status raro: presentes/ausentes en 0 pero
    // los pendientes baja de 5 a 2 (los 3 ya tienen ALGÚN record).
    const out = summarizeAttendance(sessions, records, 5);
    expect(out[0].present).toBe(0);
    expect(out[0].absent).toBe(0);
    expect(out[0].pending).toBe(2);
  });

  it("sin matriculados → pending=0", () => {
    const sessions = [{ id: "s-1", session_date: "2026-06-10", title: null }];
    const out = summarizeAttendance(sessions, [], 0);
    expect(out[0].pending).toBe(0);
  });

  it("dedup: 2 records del mismo estudiante en una sesión no doblan el conteo", () => {
    const sessions = [{ id: "s-1", session_date: "2026-06-10", title: null }];
    const records = [
      { session_id: "s-1", user_id: "u-1", status: "presente" },
      { session_id: "s-1", user_id: "u-1", status: "presente" }, // duplicado
    ];
    const out = summarizeAttendance(sessions, records, 3);
    expect(out[0].present).toBe(1);
    expect(out[0].pending).toBe(2);
  });
});

// ── Helpers utilitarios ───────────────────────────────────────────────
describe("diagCellSeverity / diagCellStatusLabel", () => {
  it("severity ordena: error < entregado_sin_calificar < sin_entregar < calificado", () => {
    expect(diagCellSeverity("error_ia")).toBeLessThan(
      diagCellSeverity("entregado_sin_calificar"),
    );
    expect(diagCellSeverity("entregado_sin_calificar")).toBeLessThan(
      diagCellSeverity("sin_entregar"),
    );
    expect(diagCellSeverity("sin_entregar")).toBeLessThan(diagCellSeverity("calificado"));
  });

  it("label devuelve cadena no vacía para cada status", () => {
    expect(diagCellStatusLabel("error_ia")).toBeTruthy();
    expect(diagCellStatusLabel("sin_entregar")).toBeTruthy();
    expect(diagCellStatusLabel("entregado_sin_calificar")).toBeTruthy();
    expect(diagCellStatusLabel("calificado")).toBeTruthy();
    expect(diagCellStatusLabel("sin_sustentacion")).toBeTruthy();
  });
});

// ── entregas en progreso / borrador NO cuentan como pendientes ────────
describe("summarizePendingGrades — entregas no enviadas", () => {
  it("examen 'en_progreso' (no entregado) → sin_entregar, no entregado_sin_calificar", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "ex-1",
      item_kind: "exam",
      status: "en_progreso",
      has_final_grade: false,
      submission_id: "s1",
    };
    const rows = summarizePendingGrades([ana], [sub], [examen]);
    expect(rows[0].status).toBe("sin_entregar");
  });

  it("examen 'completado' sin nota → entregado_sin_calificar", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "ex-1",
      item_kind: "exam",
      status: "completado",
      has_final_grade: false,
      submission_id: "s1",
    };
    const rows = summarizePendingGrades([ana], [sub], [examen]);
    expect(rows[0].status).toBe("entregado_sin_calificar");
  });

  it("matrixSummary no cuenta los borradores en entregadoSinCalificar", () => {
    const subs: DiagSubmission[] = [
      { user_id: "u-ana", item_id: "ex-1", item_kind: "exam", status: "en_progreso", has_final_grade: false },
      { user_id: "u-beto", item_id: "ex-1", item_kind: "exam", status: "completado", has_final_grade: false },
    ];
    const s = summarizeMatrix(summarizePendingGrades([ana, beto], subs, [examen]));
    expect(s.entregadoSinCalificar).toBe(1); // solo beto
    expect(s.sinEntregar).toBe(1); // ana (borrador)
  });
});

// ── sin_sustentacion (proyectos sin sustentación) ─────────────────────
describe("summarizePendingGrades — sin_sustentacion", () => {
  it("proyecto con defense_pending → sin_sustentacion (gana a calificado)", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "pr-1",
      item_kind: "project",
      status: "calificado",
      has_final_grade: true, // ai_grade presente
      defense_pending: true,
      submission_id: "psub-1",
    };
    const rows = summarizePendingGrades([ana], [sub], [proyecto]);
    expect(rows[0].status).toBe("sin_sustentacion");
    expect(rows[0].submissionId).toBe("psub-1");
  });

  it("error_ia gana a sin_sustentacion (el error es lo más accionable)", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "pr-1",
      item_kind: "project",
      status: "entregado",
      has_final_grade: true,
      defense_pending: true,
      submission_id: "psub-1",
    };
    const rows = summarizePendingGrades(
      [ana],
      [sub],
      [proyecto],
      new Set(["u-ana::project::pr-1"]),
    );
    expect(rows[0].status).toBe("error_ia");
  });

  it("proyecto con final_grade (defense_pending=false) → calificado", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "pr-1",
      item_kind: "project",
      status: "calificado",
      has_final_grade: true,
      defense_pending: false,
      submission_id: "psub-1",
    };
    const rows = summarizePendingGrades([ana], [sub], [proyecto]);
    expect(rows[0].status).toBe("calificado");
  });

  it("submissionId se propaga; null cuando no hay submission", () => {
    const sub: DiagSubmission = {
      user_id: "u-ana",
      item_id: "ex-1",
      item_kind: "exam",
      status: "entregado",
      has_final_grade: false,
      submission_id: "sub-xyz",
    };
    const rows = summarizePendingGrades([ana, beto], [sub], [examen]);
    const anaRow = rows.find((r) => r.student.id === "u-ana")!;
    const betoRow = rows.find((r) => r.student.id === "u-beto")!;
    expect(anaRow.submissionId).toBe("sub-xyz");
    expect(anaRow.status).toBe("entregado_sin_calificar");
    expect(betoRow.submissionId).toBeNull();
  });

  it("summarizeMatrix cuenta sinSustentacion", () => {
    const subs: DiagSubmission[] = [
      {
        user_id: "u-ana",
        item_id: "pr-1",
        item_kind: "project",
        status: "calificado",
        has_final_grade: true,
        defense_pending: true,
        submission_id: "p1",
      },
      {
        user_id: "u-beto",
        item_id: "pr-1",
        item_kind: "project",
        status: "calificado",
        has_final_grade: true,
        defense_pending: false,
        submission_id: "p2",
      },
    ];
    const summary = summarizeMatrix(summarizePendingGrades([ana, beto], subs, [proyecto]));
    expect(summary.sinSustentacion).toBe(1);
    expect(summary.calificado).toBe(1);
  });

  it("severidad: sin_sustentacion entre entregado_sin_calificar y sin_entregar", () => {
    expect(diagCellSeverity("entregado_sin_calificar")).toBeLessThan(
      diagCellSeverity("sin_sustentacion"),
    );
    expect(diagCellSeverity("sin_sustentacion")).toBeLessThan(diagCellSeverity("sin_entregar"));
  });
});

// ── summarizeCohortCoverage ───────────────────────────────────────────
describe("summarizeCohortCoverage", () => {
  const anaC: DiagStudent = { id: "u-ana", full_name: "Ana", institutional_email: "a@u", cohorte: "2024-1" };
  const betoC: DiagStudent = { id: "u-beto", full_name: "Beto", institutional_email: "b@u", cohorte: "2024-1" };
  const cintC: DiagStudent = { id: "u-cint", full_name: "Cinthia", institutional_email: "c@u", cohorte: "2024-2" };

  it("sin cohortes (todos null) → hasCohorts=false, sin gaps", () => {
    const r = summarizeCohortCoverage(
      [{ id: "x", full_name: "X", institutional_email: "x@u", cohorte: null }],
      [examen],
      new Map(),
    );
    expect(r.hasCohorts).toBe(false);
    expect(r.gaps).toHaveLength(0);
  });

  it("detecta cohorte sin ningún estudiante asignado a la actividad", () => {
    // examen asignado SOLO a la cohorte 2024-1 (ana) → falta 2024-2 (cinthia).
    const r = summarizeCohortCoverage(
      [anaC, betoC, cintC],
      [examen],
      new Map([["exam::ex-1", new Set(["u-ana"])]]),
    );
    expect(r.hasCohorts).toBe(true);
    expect(r.cohorts).toEqual(["2024-1", "2024-2"]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].missingCohorts).toEqual(["2024-2"]);
    expect(r.gaps[0].affectedStudents).toBe(1); // solo cinthia
  });

  it("cohorte cubierta si AL MENOS un estudiante suyo está asignado", () => {
    const r = summarizeCohortCoverage(
      [anaC, betoC, cintC],
      [examen],
      // 2024-1: solo ana (de 2). 2024-2: cinthia. Ambas cohortes cubiertas.
      new Map([["exam::ex-1", new Set(["u-ana", "u-cint"])]]),
    );
    expect(r.gaps).toHaveLength(0);
  });

  it("actividad sin NINGUNA asignación → todas las cohortes faltan", () => {
    const r = summarizeCohortCoverage([anaC, cintC], [taller], new Map());
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].missingCohorts).toEqual(["2024-1", "2024-2"]);
    expect(r.gaps[0].affectedStudents).toBe(2);
  });

  it("estudiantes sin cohorte no entran al análisis", () => {
    const sinCohorte: DiagStudent = { id: "u-z", full_name: "Z", institutional_email: "z@u", cohorte: "" };
    const r = summarizeCohortCoverage([anaC, sinCohorte], [examen], new Map());
    expect(r.cohorts).toEqual(["2024-1"]);
    // u-z no aparece en affectedStudents.
    expect(r.gaps[0].affectedStudents).toBe(1);
  });
});

// ── summarizeWeightCoverage ───────────────────────────────────────────
describe("summarizeWeightCoverage", () => {
  /** Helper: arma un corte con buckets explícitos. */
  const cut = (
    id: string,
    name: string,
    weight: number,
    buckets: { ws?: number; ex?: number; pr?: number; at?: number } = {},
  ): DiagCut => ({
    id,
    name,
    weight,
    workshop_weight: buckets.ws ?? 0,
    exam_weight: buckets.ex ?? 0,
    project_weight: buckets.pr ?? 0,
    attendance_weight: buckets.at ?? 0,
  });
  const item = (
    kind: "exam" | "workshop" | "project",
    cut_id: string | null,
    weight: number | null,
  ): DiagWeightedItem => ({ kind, cut_id, weight });

  it("sin cortes → hasCuts=false, courseTotalGap=100 (todo sin asignar)", () => {
    const r = summarizeWeightCoverage([], []);
    expect(r.hasCuts).toBe(false);
    expect(r.courseTotalAssigned).toBe(0);
    expect(r.courseTotalGap).toBe(100);
    // Sin cortes no marcamos "no suma 100" (no aplica el chequeo de cortes).
    expect(r.courseCutsNotHundred).toBe(false);
    expect(r.cuts).toHaveLength(0);
  });

  it("curso completo (cortes suman 100, buckets llenos, items completos) → sin gaps", () => {
    const cuts: DiagCut[] = [
      cut("c1", "Corte 1", 50, { ws: 20, ex: 20, pr: 0, at: 10 }),
      cut("c2", "Corte 2", 50, { ws: 0, ex: 30, pr: 20, at: 0 }),
    ];
    const items: DiagWeightedItem[] = [
      // Corte 1: talleres 20 (12+8), exámenes 20 (un parcial).
      item("workshop", "c1", 12),
      item("workshop", "c1", 8),
      item("exam", "c1", 20),
      // Corte 2: exámenes 30, proyecto 20.
      item("exam", "c2", 30),
      item("project", "c2", 20),
    ];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.hasCuts).toBe(true);
    expect(r.courseTotalAssigned).toBe(100);
    expect(r.courseTotalGap).toBe(0);
    expect(r.courseCutsNotHundred).toBe(false);
    expect(r.hasGaps).toBe(false);
    // Cada bucket sin gap.
    const c1 = r.cuts.find((c) => c.id === "c1")!;
    expect(c1.intraCutGap).toBe(0);
    expect(c1.buckets.find((b) => b.kind === "workshop")!.gap).toBe(0);
    expect(c1.buckets.find((b) => b.kind === "exam")!.gap).toBe(0);
    // Asistencia: assignedToItems == bucketWeight (10), gap 0.
    const at = c1.buckets.find((b) => b.kind === "attendance")!;
    expect(at.assignedToItems).toBe(10);
    expect(at.gap).toBe(0);
  });

  it("curso 92% (cortes suman 92) → courseTotalGap 8, courseCutsNotHundred true", () => {
    const cuts: DiagCut[] = [
      cut("c1", "Corte 1", 50, { ws: 20, ex: 20, at: 10 }),
      cut("c2", "Corte 2", 42, { ex: 42 }),
    ];
    const items: DiagWeightedItem[] = [
      item("workshop", "c1", 20),
      item("exam", "c1", 20),
      item("exam", "c2", 42),
    ];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.courseTotalAssigned).toBe(92);
    expect(r.courseTotalGap).toBe(8);
    expect(r.courseCutsNotHundred).toBe(true);
    expect(r.hasGaps).toBe(true);
  });

  it("bucket de talleres con gap (12 de 20 asignados → falta 8)", () => {
    const cuts: DiagCut[] = [cut("c1", "Corte 1", 100, { ws: 20, ex: 70, at: 10 })];
    const items: DiagWeightedItem[] = [
      // Talleres: solo 12 de los 20 del bucket → falta 8.
      item("workshop", "c1", 12),
      item("exam", "c1", 70),
    ];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.courseTotalGap).toBe(0); // el corte sí suma 100
    const c1 = r.cuts[0];
    const ws = c1.buckets.find((b) => b.kind === "workshop")!;
    expect(ws.bucketWeight).toBe(20);
    expect(ws.assignedToItems).toBe(12);
    expect(ws.gap).toBe(8);
    // Exámenes completos (70 de 70).
    const ex = c1.buckets.find((b) => b.kind === "exam")!;
    expect(ex.gap).toBe(0);
    expect(r.hasGaps).toBe(true);
  });

  it("attendance: bucket sin items → assignedToItems == bucketWeight, gap 0", () => {
    const cuts: DiagCut[] = [cut("c1", "Corte 1", 100, { ex: 80, at: 20 })];
    const items: DiagWeightedItem[] = [item("exam", "c1", 80)];
    const r = summarizeWeightCoverage(cuts, items);
    const at = r.cuts[0].buckets.find((b) => b.kind === "attendance")!;
    expect(at.bucketWeight).toBe(20);
    expect(at.assignedToItems).toBe(20);
    expect(at.gap).toBe(0);
    // Sin huecos: el corte suma 100, exámenes completos, asistencia directa.
    expect(r.hasGaps).toBe(false);
  });

  it("pesos null/0 se tratan como 0", () => {
    const cuts: DiagCut[] = [
      {
        id: "c1",
        name: "Corte 1",
        weight: null, // peso del corte sin definir
        workshop_weight: null,
        exam_weight: null,
        project_weight: null,
        attendance_weight: null,
      },
    ];
    const items: DiagWeightedItem[] = [item("workshop", "c1", null)];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.courseTotalAssigned).toBe(0);
    expect(r.courseTotalGap).toBe(100);
    const c1 = r.cuts[0];
    expect(c1.cutWeight).toBe(0);
    expect(c1.bucketsTotal).toBe(0);
    expect(c1.intraCutGap).toBe(0); // cutWeight 0 - buckets 0
    // El item con weight null suma 0 al bucket de talleres.
    expect(c1.buckets.find((b) => b.kind === "workshop")!.assignedToItems).toBe(0);
  });

  it("item sin corte (cut_id null) → cuenta como huérfano, no en ningún bucket", () => {
    const cuts: DiagCut[] = [cut("c1", "Corte 1", 100, { ws: 50, ex: 50 })];
    const items: DiagWeightedItem[] = [
      item("workshop", "c1", 50),
      item("exam", "c1", 50),
      // Taller SIN corte asignado → huérfano.
      item("workshop", null, 10),
      item("project", null, 5),
    ];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.orphanItems.workshop).toBe(1);
    expect(r.orphanItems.project).toBe(1);
    expect(r.orphanItems.exam).toBe(0);
    // El huérfano NO infla el bucket de talleres del corte (sigue en 50).
    const ws = r.cuts[0].buckets.find((b) => b.kind === "workshop")!;
    expect(ws.assignedToItems).toBe(50);
    expect(ws.gap).toBe(0);
    // Hay huecos porque hay huérfanos (aunque los buckets cuadren).
    expect(r.hasGaps).toBe(true);
  });

  it("intra-corte gap: los buckets no llenan el peso del corte", () => {
    // Corte vale 50 pero los buckets suman solo 40 → 10% del corte sin repartir.
    const cuts: DiagCut[] = [cut("c1", "Corte 1", 50, { ws: 20, ex: 20 })];
    const r = summarizeWeightCoverage(cuts, []);
    const c1 = r.cuts[0];
    expect(c1.cutWeight).toBe(50);
    expect(c1.bucketsTotal).toBe(40);
    expect(c1.intraCutGap).toBe(10);
    expect(r.hasGaps).toBe(true);
  });

  it("cortes que SUPERAN 100 → courseCutsNotHundred true, gap 0 (clamp)", () => {
    const cuts: DiagCut[] = [
      cut("c1", "Corte 1", 60, { ex: 60 }),
      cut("c2", "Corte 2", 60, { ex: 60 }),
    ];
    const items: DiagWeightedItem[] = [item("exam", "c1", 60), item("exam", "c2", 60)];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.courseTotalAssigned).toBe(120);
    expect(r.courseTotalGap).toBe(0); // clamp a >= 0
    expect(r.courseCutsNotHundred).toBe(true);
    expect(r.hasGaps).toBe(true);
  });

  it("tolerancia flotante: 33.33+33.33+33.34 ≈ 100 NO marca gap", () => {
    const cuts: DiagCut[] = [
      cut("c1", "C1", 33.33, { ex: 33.33 }),
      cut("c2", "C2", 33.33, { ex: 33.33 }),
      cut("c3", "C3", 33.34, { ex: 33.34 }),
    ];
    const items: DiagWeightedItem[] = [
      item("exam", "c1", 33.33),
      item("exam", "c2", 33.33),
      item("exam", "c3", 33.34),
    ];
    const r = summarizeWeightCoverage(cuts, items);
    expect(r.courseTotalGap).toBe(0);
    expect(r.courseCutsNotHundred).toBe(false);
    // Cada bucket de exámenes cuadra dentro de la tolerancia.
    expect(r.cuts.every((c) => c.buckets.find((b) => b.kind === "exam")!.gap === 0)).toBe(true);
    expect(r.hasGaps).toBe(false);
  });
});
