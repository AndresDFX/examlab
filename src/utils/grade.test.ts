import { describe, expect, it } from "vitest";

import {
  computeFinalGrade,
  computeCutGrade,
  computeCourseFinalGrade,
  type BreakdownItem,
  type CutWeights,
  type ManualOverride,
  type QuestionPoints,
} from "./grade";

const qs: QuestionPoints[] = [
  { id: "q1", points: 4 },
  { id: "q2", points: 3 },
  { id: "q3", points: 3 },
];

describe("computeFinalGrade", () => {
  it("returns null when there are no questions", () => {
    expect(computeFinalGrade([], [], {})).toBeNull();
  });

  it("returns null when no score exists for any question", () => {
    expect(computeFinalGrade(qs, [], {})).toBeNull();
  });

  it("scales the earned total to a 0-10 grade", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 4 },
      { qid: "q2", points: 3, earned: 3 },
      { qid: "q3", points: 3, earned: 3 },
    ];
    expect(computeFinalGrade(qs, breakdown, {})).toBe(10);
  });

  it("averages partial scores correctly", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 2 },
      { qid: "q2", points: 3, earned: 3 },
      { qid: "q3", points: 3, earned: 0 },
    ];
    // 5 / 10 * 10 = 5
    expect(computeFinalGrade(qs, breakdown, {})).toBe(5);
  });

  it("treats missing per-question breakdown as zero", () => {
    const breakdown: BreakdownItem[] = [{ qid: "q1", points: 4, earned: 4 }];
    // 4 / 10 * 10 = 4
    expect(computeFinalGrade(qs, breakdown, {})).toBe(4);
  });

  it("lets manual overrides win over AI breakdown", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 0 },
      { qid: "q2", points: 3, earned: 3 },
    ];
    const overrides: Record<string, ManualOverride> = {
      q1: { score: 4 },
    };
    // q1 (override 4) + q2 (AI 3) + q3 (none) = 7 / 10 * 10 = 7
    expect(computeFinalGrade(qs, breakdown, overrides)).toBe(7);
  });

  it("rounds to two decimals", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 1 },
      { qid: "q2", points: 3, earned: 1 },
      { qid: "q3", points: 3, earned: 1 },
    ];
    // 3 / 10 * 10 = 3
    expect(computeFinalGrade(qs, breakdown, {})).toBe(3);
  });

  it("returns null when total points are zero", () => {
    const zeroQs: QuestionPoints[] = [{ id: "q1", points: 0 }];
    const breakdown: BreakdownItem[] = [{ qid: "q1", points: 0, earned: 0 }];
    expect(computeFinalGrade(zeroQs, breakdown, {})).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Course → Cuts → [Workshops, Exams, Projects, Attendance]
// ─────────────────────────────────────────────────────────────────────────────

const fullWeights: CutWeights = { workshop: 30, exam: 40, project: 20, attendance: 10 };

describe("computeCutGrade", () => {
  it("calcula correctamente con los 4 componentes (escala 0-5)", () => {
    // 4.0 * 0.30 + 3.0 * 0.40 + 5.0 * 0.20 + 4.5 * 0.10
    // = 1.20 + 1.20 + 1.00 + 0.45 = 3.85 — pero el helper divide entre totalWeight
    // Como sumWeights = 100 → media ponderada = 3.85
    const r = computeCutGrade(
      { workshop: 4.0, exam: 3.0, project: 5.0, attendance: 4.5 },
      fullWeights,
    );
    expect(r).toBe(3.85);
  });

  it("reescala los pesos cuando faltan componentes (proyecto null)", () => {
    // Solo workshop(30%), exam(40%), attendance(10%) → totalWeight = 80
    // (4.0*30 + 3.0*40 + 4.5*10) / 80 = (120 + 120 + 45) / 80 = 285/80 = 3.5625 → 3.56
    const r = computeCutGrade(
      { workshop: 4.0, exam: 3.0, project: null, attendance: 4.5 },
      fullWeights,
    );
    expect(r).toBe(3.56);
  });

  it("usa solo el componente disponible si los demás son null", () => {
    const r = computeCutGrade(
      { workshop: null, exam: 3.0, project: null, attendance: null },
      fullWeights,
    );
    expect(r).toBe(3);
  });

  it("retorna null si todos los componentes son null", () => {
    expect(
      computeCutGrade(
        { workshop: null, exam: null, project: null, attendance: null },
        fullWeights,
      ),
    ).toBeNull();
  });

  it("ignora componentes con peso 0 aunque tengan score", () => {
    // Workshop con peso 0 no debe contar; resto: exam(40)+project(20)+att(10)=70
    // (3*40 + 5*20 + 4.5*10) / 70 = (120+100+45)/70 = 265/70 = 3.7857 → 3.79
    const r = computeCutGrade(
      { workshop: 4.0, exam: 3.0, project: 5.0, attendance: 4.5 },
      { workshop: 0, exam: 40, project: 20, attendance: 10 },
    );
    expect(r).toBe(3.79);
  });

  it("retorna null si la suma de pesos efectiva es 0", () => {
    expect(
      computeCutGrade(
        { workshop: 4, exam: 3, project: 5, attendance: 4.5 },
        { workshop: 0, exam: 0, project: 0, attendance: 0 },
      ),
    ).toBeNull();
  });
});

describe("computeCourseFinalGrade", () => {
  it("suma ponderadamente los cortes (3 cortes con datos completos)", () => {
    // (3.5*30 + 4.0*30 + 4.5*40) / 100 = (105 + 120 + 180) / 100 = 4.05
    const r = computeCourseFinalGrade([
      { weight: 30, grade: 3.5 },
      { weight: 30, grade: 4.0 },
      { weight: 40, grade: 4.5 },
    ]);
    expect(r).toBe(4.05);
  });

  it("dos cortes 40/60 con notas 3.75 y 4.0 → 3.9", () => {
    const r = computeCourseFinalGrade([
      { weight: 40, grade: 3.75 },
      { weight: 60, grade: 4.0 },
    ]);
    expect(r).toBe(3.9);
  });

  it("ignora cortes sin nota (reescala los demás)", () => {
    // Corte 1 sin datos, Corte 2 (60%) y Corte 3 (40%) calificados
    const r = computeCourseFinalGrade([
      { weight: 30, grade: null },
      { weight: 60, grade: 4.0 },
      { weight: 40, grade: 3.0 },
    ]);
    // (4*60 + 3*40) / 100 = (240 + 120) / 100 = 3.6
    expect(r).toBe(3.6);
  });

  it("ignora cortes con peso 0", () => {
    const r = computeCourseFinalGrade([
      { weight: 0, grade: 5.0 },
      { weight: 100, grade: 3.0 },
    ]);
    expect(r).toBe(3);
  });

  it("retorna null si no hay cortes", () => {
    expect(computeCourseFinalGrade([])).toBeNull();
  });

  it("retorna null si todos los cortes están sin nota", () => {
    const r = computeCourseFinalGrade([
      { weight: 50, grade: null },
      { weight: 50, grade: null },
    ]);
    expect(r).toBeNull();
  });
});
