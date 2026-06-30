import { describe, expect, it } from "vitest";

import {
  computeFinalGrade,
  computeCutGrade,
  computeCourseFinalGrade,
  computeWeightedGrade,
  type BreakdownItem,
  type CutWeights,
  type GradedItem,
  type ManualOverride,
  type QuestionPoints,
  countsAsPresent,
  scaleAttendance,
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

  it("componentes null cuentan como 0 con su peso original (proyecto null)", () => {
    // Antes reescalaba; ahora project null = 0, sigue dividiendo entre 100.
    // (4.0*30 + 3.0*40 + 0*20 + 4.5*10) / 100 = (120 + 120 + 0 + 45) / 100 = 2.85
    const r = computeCutGrade(
      { workshop: 4.0, exam: 3.0, project: null, attendance: 4.5 },
      fullWeights,
    );
    expect(r).toBe(2.85);
  });

  it("componentes null cuentan como 0: solo exam=3 con peso 40 → 1.20", () => {
    // 3*40 + 0*30 + 0*20 + 0*10 = 120 / 100 = 1.20
    const r = computeCutGrade(
      { workshop: null, exam: 3.0, project: null, attendance: null },
      fullWeights,
    );
    expect(r).toBe(1.2);
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

describe("computeWeightedGrade", () => {
  it("retorna null para lista vacía", () => {
    expect(computeWeightedGrade([])).toBeNull();
  });

  it("retorna null si todos los items tienen peso 0", () => {
    const items: GradedItem[] = [
      { weight: 0, score: 5 },
      { weight: 0, score: 3 },
    ];
    expect(computeWeightedGrade(items)).toBeNull();
  });

  it("retorna null si ningún item con peso tiene score (todo null)", () => {
    const items: GradedItem[] = [
      { weight: 50, score: null },
      { weight: 50, score: null },
    ];
    expect(computeWeightedGrade(items)).toBeNull();
  });

  it("promedio ponderado con todos los scores presentes", () => {
    const items: GradedItem[] = [
      { weight: 30, score: 4.0 },
      { weight: 40, score: 3.0 },
      { weight: 30, score: 5.0 },
    ];
    // (4*30 + 3*40 + 5*30) / 100 = (120 + 120 + 150) / 100 = 3.9
    expect(computeWeightedGrade(items)).toBe(3.9);
  });

  it("items con score null cuentan como 0 con su peso original (no reescala)", () => {
    const items: GradedItem[] = [
      { weight: 50, score: 4.0 },
      { weight: 50, score: null },
    ];
    // (4*50 + 0*50) / 100 = 2.0 — el null pesa como 0
    expect(computeWeightedGrade(items)).toBe(2);
  });

  it("ignora items con peso 0 aunque tengan score", () => {
    const items: GradedItem[] = [
      { weight: 0, score: 5.0 }, // ignorado
      { weight: 100, score: 3.0 },
    ];
    expect(computeWeightedGrade(items)).toBe(3);
  });

  it("redondea a dos decimales", () => {
    const items: GradedItem[] = [
      { weight: 33, score: 4.0 },
      { weight: 33, score: 3.5 },
      { weight: 34, score: 4.7 },
    ];
    // (4*33 + 3.5*33 + 4.7*34) / 100 = (132 + 115.5 + 159.8) / 100 = 4.073 → 4.07
    expect(computeWeightedGrade(items)).toBe(4.07);
  });

  it("acepta pesos que no suman 100 — divide entre totalWeight", () => {
    const items: GradedItem[] = [
      { weight: 25, score: 4.0 },
      { weight: 25, score: 3.0 },
    ];
    // total = 50, promedio = (4*25 + 3*25)/50 = 175/50 = 3.5
    expect(computeWeightedGrade(items)).toBe(3.5);
  });

  it("un solo item con peso lo retorna como su propia nota", () => {
    expect(computeWeightedGrade([{ weight: 100, score: 4.2 }])).toBe(4.2);
  });

  it("score 0 explícito cuenta (no es lo mismo que null)", () => {
    const items: GradedItem[] = [
      { weight: 50, score: 0 },
      { weight: 50, score: 4 },
    ];
    expect(computeWeightedGrade(items)).toBe(2);
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

  it("cortes sin nota cuentan como 0 con su peso original", () => {
    // Corte 1 sin datos (peso 30) cuenta como 0. Pesos suman 130 (no 100,
    // pero la fórmula divide por totalWeight, así que igual funciona).
    // (0*30 + 4*60 + 3*40) / 130 = 360/130 = 2.769... → 2.77
    const r = computeCourseFinalGrade([
      { weight: 30, grade: null },
      { weight: 60, grade: 4.0 },
      { weight: 40, grade: 3.0 },
    ]);
    expect(r).toBe(2.77);
  });

  it("caso real: solo Corte 1 calificado 4.20 (30%), Corte 2/3 sin nota → 1.26", () => {
    // 4.20*30 + 0*30 + 0*40 = 126 / 100 = 1.26
    const r = computeCourseFinalGrade([
      { weight: 30, grade: 4.2 },
      { weight: 30, grade: null },
      { weight: 40, grade: null },
    ]);
    expect(r).toBe(1.26);
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

describe("countsAsPresent (invariante de asistencia — decisión 2026-06-30: 'tarde' cuenta)", () => {
  it("'presente' y 'tarde' cuentan; el resto no", () => {
    expect(countsAsPresent("presente")).toBe(true);
    expect(countsAsPresent("tarde")).toBe(true);
    expect(countsAsPresent("ausente")).toBe(false);
    expect(countsAsPresent("excusado")).toBe(false);
    expect(countsAsPresent(null)).toBe(false);
    expect(countsAsPresent(undefined)).toBe(false);
    expect(countsAsPresent("")).toBe(false);
  });
});

describe("scaleAttendance (escala al rango [min,max] del curso)", () => {
  it("escala 0%/50%/100% en una escala 0..5", () => {
    expect(scaleAttendance(0, 0, 5)).toBe(0);
    expect(scaleAttendance(0.5, 0, 5)).toBe(2.5);
    expect(scaleAttendance(1, 0, 5)).toBe(5);
  });
  it("respeta grade_scale_min > 0 (el bug G2: pct*max lo ignoraba)", () => {
    // Escala 1..5, 50% asistencia → 1 + 0.5*(5-1) = 3.0  (pct*max daría 2.5)
    expect(scaleAttendance(0.5, 1, 5)).toBe(3);
    // 0% asistencia en escala 1..5 → la nota mínima (1), no 0
    expect(scaleAttendance(0, 1, 5)).toBe(1);
    expect(scaleAttendance(1, 1, 5)).toBe(5);
  });
});

describe("nota final: PLANO vs avg-de-cortes (G1/G5 — por qué deben unificarse)", () => {
  // Caracteriza la divergencia que motivó alinear acta/boletín al gradebook.
  // Con asignación PARCIAL de pesos (los items de un corte NO suman el peso del
  // corte), el promedio plano ≠ el promedio de las notas de corte.
  it("coinciden cuando los pesos de items suman exactamente el peso del corte", () => {
    // Corte A (peso 50): 2 items de 25+25=50. Corte B (peso 50): 1 item de 50.
    const flat = computeWeightedGrade([
      { weight: 25, score: 4 },
      { weight: 25, score: 2 },
      { weight: 50, score: 5 },
    ]);
    const cutA = computeWeightedGrade([
      { weight: 25, score: 4 },
      { weight: 25, score: 2 },
    ]); // = 3
    const cutB = 5;
    const avgOfCuts = computeCourseFinalGrade([
      { weight: 50, grade: cutA },
      { weight: 50, grade: cutB },
    ]);
    expect(flat).toBe(4); // (4*25+2*25+5*50)/100 = 400/100
    expect(avgOfCuts).toBe(4); // (3*50+5*50)/100 — coinciden
  });

  it("DIVERGEN con asignación parcial (items NO suman el peso del corte)", () => {
    // Corte A peso 60 pero solo tiene 1 item de peso 20 (40 sin asignar).
    // Corte B peso 40 con 1 item de peso 40.
    const flat = computeWeightedGrade([
      { weight: 20, score: 5 }, // corte A (item)
      { weight: 40, score: 0 }, // corte B (item)
    ]); // = (5*20 + 0*40)/60 = 100/60 = 1.67
    const cutA = 5; // único item del corte A
    const cutB = 0;
    const avgOfCuts = computeCourseFinalGrade([
      { weight: 60, grade: cutA },
      { weight: 40, grade: cutB },
    ]); // = (5*60 + 0*40)/100 = 3.0
    expect(flat).toBe(1.67);
    expect(avgOfCuts).toBe(3);
    expect(flat).not.toBe(avgOfCuts); // ← el acta usaba avg-de-cortes; el gradebook usa flat
  });
});
