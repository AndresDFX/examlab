import { describe, expect, it } from "vitest";
import {
  computeApproval,
  computeAttendanceBySession,
  computeCutTrend,
  computeFailedStudents,
  computeFraudStats,
  computeGradeDistribution,
  computeNoPresentedStudents,
  effectiveGrade,
  isApproved,
  type AttendanceRecord,
  type AttendanceSession,
  type CourseInfo,
  type Cut,
  type SimilarityPair,
  type SubmissionLike,
} from "./statistics";

// Helpers para no repetir defaults en cada caso.
const course = (over: Partial<CourseInfo> = {}): CourseInfo => ({
  id: "c1",
  name: "Curso X",
  period: null,
  passing_grade: 3,
  grade_scale_min: 0,
  grade_scale_max: 5,
  ...over,
});

const sub = (over: Partial<SubmissionLike> = {}): SubmissionLike => ({
  id: "s1",
  user_id: "u1",
  status: "calificado",
  ai_grade: null,
  final_grade: null,
  ai_detected: null,
  ai_detected_score: null,
  ref_id: "ref1",
  course_id: "c1",
  cut_id: null,
  max_score: 100,
  is_external: false,
  ...over,
});

describe("effectiveGrade", () => {
  it("prioriza final_grade sobre ai_grade", () => {
    expect(effectiveGrade(sub({ final_grade: 4, ai_grade: 2 }))).toBe(4);
  });

  it("usa ai_grade cuando final_grade es null", () => {
    expect(effectiveGrade(sub({ final_grade: null, ai_grade: 3 }))).toBe(3);
  });

  it("retorna null cuando ambos son null", () => {
    expect(effectiveGrade(sub({ final_grade: null, ai_grade: null }))).toBeNull();
  });
});

describe("isApproved", () => {
  it("reescala antes de comparar con passing_grade del curso", () => {
    // Curso escala 0-5 con passing=3.
    // Submission con max_score=100 y nota 60 → escalado = (60/100)*5 = 3 → aprueba
    expect(isApproved(sub({ ai_grade: 60, max_score: 100 }), course())).toBe(true);
    // nota 59 → escalado 2.95 → reprueba
    expect(isApproved(sub({ ai_grade: 59, max_score: 100 }), course())).toBe(false);
  });

  it("retorna null sin nota", () => {
    expect(isApproved(sub(), course())).toBeNull();
  });

  it("usa max_score=1 cuando viene 0 (defensa contra div-zero)", () => {
    // s.max_score = 0 → fallback a 1. Nota 4 → escalado (4/1)*5 = 20 → aprueba.
    expect(isApproved(sub({ ai_grade: 4, max_score: 0 }), course())).toBe(true);
  });
});

describe("computeApproval", () => {
  it("cuenta approved/failed/pending sobre la grilla (matriculados x actividades)", () => {
    const c = course();
    const subs: SubmissionLike[] = [
      sub({ id: "1", user_id: "u1", ref_id: "exam1", ai_grade: 4, max_score: 5 }), // aprueba
      sub({ id: "2", user_id: "u2", ref_id: "exam1", ai_grade: 2, max_score: 5 }), // reprueba
      // u3 NO entrego exam1
    ];
    const enrolled = new Set(["u1", "u2", "u3"]);
    const r = computeApproval(subs, enrolled, c);
    expect(r).toEqual({ approved: 1, failed: 1, pending: 1, total: 3 });
  });

  it("total = #activities × #enrolled", () => {
    const c = course();
    const subs: SubmissionLike[] = [
      sub({ ref_id: "a", user_id: "u1", ai_grade: 4, max_score: 5 }),
      sub({ ref_id: "b", user_id: "u1", ai_grade: 4, max_score: 5 }),
    ];
    const enrolled = new Set(["u1", "u2"]);
    const r = computeApproval(subs, enrolled, c);
    // 2 refs x 2 enrolled = 4
    expect(r.total).toBe(4);
    expect(r.approved + r.failed + r.pending).toBe(4);
  });

  it("multiples submissions del mismo (user, ref): prefiere la calificada", () => {
    const c = course();
    const subs: SubmissionLike[] = [
      sub({ ref_id: "x", user_id: "u1", ai_grade: null }), // sin nota
      sub({ ref_id: "x", user_id: "u1", ai_grade: 4, max_score: 5 }), // con nota
    ];
    const enrolled = new Set(["u1"]);
    expect(computeApproval(subs, enrolled, c).approved).toBe(1);
  });

  it("celda sin submission → pending", () => {
    const c = course();
    const subs: SubmissionLike[] = [
      sub({ ref_id: "x", user_id: "u1", ai_grade: 4, max_score: 5 }),
    ];
    const enrolled = new Set(["u1", "u2"]);
    const r = computeApproval(subs, enrolled, c);
    expect(r.approved).toBe(1);
    expect(r.pending).toBe(1);
  });
});

describe("computeFailedStudents", () => {
  it("escenario del scout: 1 perdió el examen", () => {
    const c = course(); // escala 0-5, passing 3
    const subs: SubmissionLike[] = [
      sub({ id: "1", user_id: "u1", ref_id: "exam1", ai_grade: 4, max_score: 5 }), // aprueba
      sub({ id: "2", user_id: "u2", ref_id: "exam1", ai_grade: 2, max_score: 5 }), // pierde
      // u3 no presentó (no aparece acá)
    ];
    const enrolled = new Set(["u1", "u2", "u3"]);
    const r = computeFailedStudents(subs, enrolled, c);
    expect(r.failed).toBe(1);
    expect(r.ids).toEqual(["u2"]);
  });

  it("cuenta estudiantes únicos (un alumno que reprueba 2 exámenes cuenta 1)", () => {
    const c = course();
    const subs: SubmissionLike[] = [
      sub({ user_id: "u1", ref_id: "exam1", ai_grade: 1, max_score: 5 }),
      sub({ user_id: "u1", ref_id: "exam2", ai_grade: 2, max_score: 5 }),
    ];
    const enrolled = new Set(["u1"]);
    expect(computeFailedStudents(subs, enrolled, c).failed).toBe(1);
  });

  it("ignora entregas de no-matriculados (desmatriculados)", () => {
    const c = course();
    const subs: SubmissionLike[] = [
      sub({ user_id: "ghost", ref_id: "exam1", ai_grade: 1, max_score: 5 }),
    ];
    const enrolled = new Set(["u1"]);
    expect(computeFailedStudents(subs, enrolled, c).failed).toBe(0);
  });

  it("entrega sin nota no cuenta como perdió", () => {
    const c = course();
    const subs: SubmissionLike[] = [sub({ user_id: "u1", ref_id: "exam1", ai_grade: null })];
    const enrolled = new Set(["u1"]);
    expect(computeFailedStudents(subs, enrolled, c).failed).toBe(0);
  });
});

describe("computeNoPresentedStudents", () => {
  it("escenario del scout: 1 no presentó", () => {
    const subs: SubmissionLike[] = [
      sub({ user_id: "u1", ref_id: "exam1", ai_grade: 4, max_score: 5 }),
      sub({ user_id: "u2", ref_id: "exam1", ai_grade: 2, max_score: 5 }),
      // u3 sin entrega
    ];
    const enrolled = new Set(["u1", "u2", "u3"]);
    const r = computeNoPresentedStudents(subs, enrolled);
    expect(r.notPresented).toBe(1);
    expect(r.ids).toEqual(["u3"]);
  });

  it("estudiante con entrega sin nota SÍ presentó (no cuenta)", () => {
    const subs: SubmissionLike[] = [sub({ user_id: "u1", ref_id: "exam1", ai_grade: null })];
    const enrolled = new Set(["u1"]);
    expect(computeNoPresentedStudents(subs, enrolled).notPresented).toBe(0);
  });

  it("sin entregas → todos los matriculados no presentaron", () => {
    const enrolled = new Set(["u1", "u2"]);
    const r = computeNoPresentedStudents([], enrolled);
    expect(r.notPresented).toBe(2);
    expect(r.ids.sort()).toEqual(["u1", "u2"]);
  });

  it("ignora entregas de no-matriculados al determinar presencia", () => {
    const subs: SubmissionLike[] = [
      sub({ user_id: "ghost", ref_id: "exam1", ai_grade: 4, max_score: 5 }),
    ];
    const enrolled = new Set(["u1"]);
    // ghost no está matriculado; u1 no tiene entrega → 1 no presentó
    expect(computeNoPresentedStudents(subs, enrolled).notPresented).toBe(1);
  });
});

describe("computeGradeDistribution", () => {
  it("genera 5 buckets cubriendo la escala completa", () => {
    const d = computeGradeDistribution([], course());
    expect(d).toHaveLength(5);
  });

  it("distribuye correctamente reescalando al rango del curso", () => {
    const c = course({ grade_scale_min: 0, grade_scale_max: 5 });
    const subs: SubmissionLike[] = [
      sub({ ai_grade: 5, max_score: 100 }), // (5/100)*5 = 0.25 → bucket 0
      sub({ ai_grade: 50, max_score: 100 }), // 2.5 → bucket 2 (2-3)
      sub({ ai_grade: 100, max_score: 100 }), // 5.0 → ultimo bucket
    ];
    const d = computeGradeDistribution(subs, c);
    const total = d.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(3);
    expect(d[0].count).toBe(1); // 0.25
    expect(d[2].count).toBe(1); // 2.5
    expect(d[4].count).toBe(1); // 5.0
  });

  it("ignora submissions sin nota", () => {
    const d = computeGradeDistribution([sub()], course());
    expect(d.every((b) => b.count === 0)).toBe(true);
  });
});

describe("computeFraudStats", () => {
  it("cuenta entregas sospechosas por IA (>= 0.6)", () => {
    const subs: SubmissionLike[] = [
      sub({ ai_detected_score: 0.9 }),
      sub({ ai_detected_score: 0.6 }),
      sub({ ai_detected_score: 0.59 }), // bajo umbral
      sub({ ai_detected_score: null }), // ignorado
    ];
    const r = computeFraudStats(subs, []);
    expect(r.aiSuspect).toBe(2);
    expect(r.totalGraded).toBe(3); // las que tienen score (incluye 0.59)
  });

  it("cuenta pares de plagio por encima de 0.6", () => {
    const pairs: SimilarityPair[] = [
      { kind: "exam", ref_id: "e1", score: 0.9, user_a: "u1", user_b: "u2" },
      { kind: "exam", ref_id: "e1", score: 0.7, user_a: "u2", user_b: "u3" },
      { kind: "exam", ref_id: "e2", score: 0.5, user_a: "u4", user_b: "u5" }, // bajo umbral
    ];
    const r = computeFraudStats([], pairs);
    expect(r.plagiarismPairs).toBe(2);
    // u1,u2,u3 = 3 estudiantes distintos arriba del umbral
    expect(r.plagiarismStudents).toBe(3);
  });
});

describe("computeAttendanceBySession", () => {
  it("retorna [] si no hay matriculados", () => {
    const sessions: AttendanceSession[] = [
      { id: "s1", course_id: "c1", session_date: "2026-09-30", cut_id: null },
    ];
    expect(computeAttendanceBySession(sessions, [], 0)).toEqual([]);
  });

  it("calcula presentPct correctamente y ordena por fecha", () => {
    const sessions: AttendanceSession[] = [
      { id: "s2", course_id: "c1", session_date: "2026-10-02", cut_id: null },
      { id: "s1", course_id: "c1", session_date: "2026-09-30", cut_id: null },
    ];
    const records: AttendanceRecord[] = [
      { session_id: "s1", user_id: "u1", status: "presente" },
      { session_id: "s1", user_id: "u2", status: "ausente" },
      { session_id: "s2", user_id: "u1", status: "presente" },
      { session_id: "s2", user_id: "u2", status: "presente" },
    ];
    const r = computeAttendanceBySession(sessions, records, 4);
    // Ordenado por fecha ascendente
    expect(r[0].date).toBe("2026-09-30");
    expect(r[1].date).toBe("2026-10-02");
    // Solo 1/4 presente en s1 = 25%; 2/4 en s2 = 50%
    expect(r[0].presentPct).toBe(25);
    expect(r[1].presentPct).toBe(50);
  });
});

describe("computeCutTrend", () => {
  it("promedia notas por corte reescalando al curso", () => {
    const c = course({ grade_scale_max: 5 });
    const cuts: Cut[] = [
      { id: "cut1", course_id: "c1", name: "Corte 1", position: 1 },
      { id: "cut2", course_id: "c1", name: "Corte 2", position: 2 },
    ];
    const examSubs: SubmissionLike[] = [
      sub({ cut_id: "cut1", ai_grade: 80, max_score: 100 }), // 4.0
      sub({ cut_id: "cut1", ai_grade: 100, max_score: 100 }), // 5.0
    ];
    const r = computeCutTrend(examSubs, [], [], cuts, c);
    expect(r[0]).toEqual({ cut: "Corte 1", avg: 4.5 });
    expect(r[1]).toEqual({ cut: "Corte 2", avg: null });
  });
});
