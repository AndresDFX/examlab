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
  diagCellSeverity,
  diagCellStatusLabel,
  type DiagItem,
  type DiagStudent,
  type DiagSubmission,
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
