import { describe, expect, it } from "vitest";
import {
  classifyCourse,
  classifyStudent,
  computeStudentAttendance,
  DEFAULT_RISK_THRESHOLDS,
  levelForReasons,
  summarizeRisk,
  thresholdsFromSettings,
  type RiskReasonKind,
} from "./early-alert";
import type {
  AttendanceRecord,
  AttendanceSession,
  CourseInfo,
  SubmissionLike,
} from "./statistics";

const course: CourseInfo = {
  id: "c1",
  name: "Curso",
  period: null,
  passing_grade: 3,
  grade_scale_min: 0,
  grade_scale_max: 5,
};

/** Entrega mínima; `grade` va como final_grade (override del docente). */
function sub(
  refId: string,
  userId: string,
  grade: number | null,
  extra: Partial<SubmissionLike> = {},
): SubmissionLike {
  return {
    id: `${refId}-${userId}`,
    user_id: userId,
    status: "entregado",
    ai_grade: null,
    final_grade: grade,
    ai_detected: null,
    ai_detected_score: null,
    ref_id: refId,
    course_id: "c1",
    cut_id: null,
    max_score: 5,
    is_external: false,
    ...extra,
  };
}

function session(id: string): AttendanceSession {
  return { id, course_id: "c1", session_date: "2026-03-01", cut_id: null };
}

function rec(sessionId: string, userId: string, status: string): AttendanceRecord {
  return { session_id: sessionId, user_id: userId, status };
}

const kinds = (r: { reasons: Array<{ kind: RiskReasonKind }> }) =>
  r.reasons.map((x) => x.kind);

describe("computeStudentAttendance — las tres reglas de justicia", () => {
  const sessions = [session("s1"), session("s2"), session("s3"), session("s4")];

  it("'tarde' cuenta como que asistió, no como ausencia", () => {
    // Llegar tarde es disciplina, no deserción. Si contara como ausencia, un
    // estudiante que va a TODAS las clases pero llega tarde quedaría en rojo.
    const records = [
      rec("s1", "u1", "presente"),
      rec("s2", "u1", "tarde"),
      rec("s3", "u1", "tarde"),
      rec("s4", "u1", "tarde"),
    ];
    const out = computeStudentAttendance("u1", sessions, records);
    expect(out.rate).toBe(1);
    expect(out.absent).toBe(0);
  });

  it("'justificado' sale del denominador (no empuja al rojo)", () => {
    // 1 presente + 3 justificadas. Si las justificadas contaran como
    // ausencia la tasa sería 25% y el estudiante quedaría marcado por algo
    // que la institución YA le excusó.
    const records = [
      rec("s1", "u1", "presente"),
      rec("s2", "u1", "justificado"),
      rec("s3", "u1", "justificado"),
      rec("s4", "u1", "justificado"),
    ];
    const out = computeStudentAttendance("u1", sessions, records);
    expect(out.rate).toBe(1);
    expect(out.considered).toBe(1);
  });

  it("sin registros → rate null (ausencia de dato, NO 0% de asistencia)", () => {
    // Un curso donde el docente nunca tomó asistencia no debe marcar a nadie.
    const out = computeStudentAttendance("u1", sessions, []);
    expect(out.rate).toBeNull();
    expect(out.considered).toBe(0);
  });

  it("ignora registros de sesiones que no pertenecen al set dado", () => {
    // Sesión borrada o de otro curso: su registro no puede contaminar.
    const records = [rec("s1", "u1", "presente"), rec("ajena", "u1", "ausente")];
    const out = computeStudentAttendance("u1", sessions, records);
    expect(out.rate).toBe(1);
    expect(out.absent).toBe(0);
  });

  it("ignora registros de otros estudiantes", () => {
    const records = [rec("s1", "u1", "presente"), rec("s2", "u2", "ausente")];
    expect(computeStudentAttendance("u1", sessions, records).absent).toBe(0);
  });

  it("mezcla real: 2 presentes, 1 ausente, 1 justificada → 2/3", () => {
    const records = [
      rec("s1", "u1", "presente"),
      rec("s2", "u1", "presente"),
      rec("s3", "u1", "ausente"),
      rec("s4", "u1", "justificado"),
    ];
    const out = computeStudentAttendance("u1", sessions, records);
    expect(out.rate).toBeCloseTo(2 / 3);
    expect(out.absent).toBe(1);
    expect(out.considered).toBe(3);
  });
});

describe("levelForReasons — hacen falta 2 señales para el rojo", () => {
  it("0 motivos → sin riesgo", () => {
    expect(levelForReasons(0)).toBe("sin_riesgo");
  });
  it("1 motivo → en observación", () => {
    expect(levelForReasons(1)).toBe("en_observacion");
  });
  it("2+ motivos → en riesgo", () => {
    expect(levelForReasons(2)).toBe("en_riesgo");
    expect(levelForReasons(4)).toBe("en_riesgo");
  });
});

describe("classifyStudent", () => {
  it("estudiante al día → sin riesgo y sin motivos", () => {
    const subs = [sub("e1", "u1", 4.5), sub("e2", "u1", 4)];
    const r = classifyStudent(
      "u1",
      subs,
      [session("s1")],
      [rec("s1", "u1", "presente")],
      course,
    );
    expect(r.level).toBe("sin_riesgo");
    expect(r.reasons).toEqual([]);
    expect(r.averageGrade).toBeCloseTo(4.25);
    expect(r.gradedCount).toBe(2);
  });

  it("una sola señal → en observación, no en riesgo", () => {
    // 3 reprobadas (umbral 2) pero asistencia perfecta y promedio arriba de
    // 3 no se logra si reprueba 3... así que uso no_entregadas como señal
    // única: no entregó 3 de 4, pero lo que entregó lo aprobó.
    const subs = [
      sub("e1", "u1", 5),
      // e2..e4 solo las tiene otro estudiante → para u1 son no entregadas
      sub("e2", "u2", 4),
      sub("e3", "u2", 4),
      sub("e4", "u2", 4),
    ];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.missingCount).toBe(3);
    expect(kinds(r)).toEqual(["no_entregadas"]);
    expect(r.level).toBe("en_observacion");
  });

  it("dos señales independientes → en riesgo", () => {
    // No entregó 3 + asistencia 40%
    const subs = [
      sub("e1", "u1", 5),
      sub("e2", "u2", 4),
      sub("e3", "u2", 4),
      sub("e4", "u2", 4),
    ];
    const sessions = [session("s1"), session("s2"), session("s3")];
    const records = [
      rec("s1", "u1", "presente"),
      rec("s2", "u1", "ausente"),
      rec("s3", "u1", "ausente"),
    ];
    const r = classifyStudent("u1", subs, sessions, records, course);
    expect(r.level).toBe("en_riesgo");
    expect(kinds(r)).toContain("no_entregadas");
    expect(kinds(r)).toContain("inasistencia");
  });

  it("promedio bajo usa el passing_grade del curso, no un umbral aparte", () => {
    const subs = [sub("e1", "u1", 2), sub("e2", "u1", 2.5)];
    const r = classifyStudent("u1", subs, [], [], course);
    const reason = r.reasons.find((x) => x.kind === "promedio_bajo");
    expect(reason).toBeDefined();
    expect(reason!.threshold).toBe(3);
    expect(reason!.value).toBeCloseTo(2.25);
  });

  it("sin nada calificado → promedio null y NO dispara promedio_bajo", () => {
    // Entregó pero nadie calificó todavía: no se le puede imputar un
    // promedio bajo que no existe.
    const subs = [sub("e1", "u1", null), sub("e2", "u1", null)];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.averageGrade).toBeNull();
    expect(kinds(r)).not.toContain("promedio_bajo");
  });

  it("reescala max_score distinto de la escala del curso", () => {
    // 40/100 = 2.0 en escala 0-5 → reprobada y promedio bajo.
    const subs = [sub("e1", "u1", 40, { max_score: 100 })];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.averageGrade).toBeCloseTo(2);
    expect(r.failedCount).toBe(1);
  });

  it("nota reescalada que aprueba no cuenta como reprobada", () => {
    // 80/100 = 4.0 en escala 0-5.
    const subs = [sub("e1", "u1", 80, { max_score: 100 })];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.failedCount).toBe(0);
    expect(r.averageGrade).toBeCloseTo(4);
  });

  it("prioriza final_grade del docente sobre ai_grade", () => {
    const subs = [sub("e1", "u1", 5, { ai_grade: 1 })];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.averageGrade).toBeCloseTo(5);
    expect(r.failedCount).toBe(0);
  });

  it("usa ai_grade cuando no hay override del docente", () => {
    const subs = [sub("e1", "u1", null, { ai_grade: 2 })];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.averageGrade).toBeCloseTo(2);
    expect(r.failedCount).toBe(1);
  });

  it("con varias entregas de la misma actividad se queda con la calificada", () => {
    // Re-entrega: la fila sin nota no debe tapar a la calificada ni contar
    // como actividad aparte.
    const subs = [sub("e1", "u1", null), sub("e1", "u1", 4)];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.gradedCount).toBe(1);
    expect(r.averageGrade).toBeCloseTo(4);
    expect(r.missingCount).toBe(0);
  });

  it("una actividad que NADIE entregó no cuenta como no entregada", () => {
    // Limitación documentada: el universo de actividades sale de las
    // entregas. Es aceptable porque el faltante sería igual para todos y no
    // distingue a nadie.
    const subs = [sub("e1", "u1", 4)];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.missingCount).toBe(0);
  });

  it("curso sin asistencia registrada no dispara motivo de inasistencia", () => {
    const subs = [sub("e1", "u1", 4)];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.attendanceRate).toBeNull();
    expect(kinds(r)).not.toContain("inasistencia");
  });

  it("respeta umbrales personalizados de la institución", () => {
    // Con el default (max 2 reprobadas) 2 no dispara; con umbral 1 sí.
    const subs = [sub("e1", "u1", 1), sub("e2", "u1", 1)];
    const laxo = classifyStudent("u1", subs, [], [], course, {
      ...DEFAULT_RISK_THRESHOLDS,
      maxFailedActivities: 2,
    });
    expect(kinds(laxo)).not.toContain("reprobadas");

    const estricto = classifyStudent("u1", subs, [], [], course, {
      ...DEFAULT_RISK_THRESHOLDS,
      maxFailedActivities: 1,
    });
    expect(kinds(estricto)).toContain("reprobadas");
  });

  it("umbral de asistencia configurable", () => {
    const sessions = [session("s1"), session("s2")];
    const records = [rec("s1", "u1", "presente"), rec("s2", "u1", "ausente")];
    // 50% de asistencia: con umbral 0.75 dispara, con 0.4 no.
    const a = classifyStudent("u1", [], sessions, records, course, {
      ...DEFAULT_RISK_THRESHOLDS,
      minAttendanceRate: 0.75,
    });
    expect(kinds(a)).toContain("inasistencia");
    const b = classifyStudent("u1", [], sessions, records, course, {
      ...DEFAULT_RISK_THRESHOLDS,
      minAttendanceRate: 0.4,
    });
    expect(kinds(b)).not.toContain("inasistencia");
  });

  it("motivos ordenados por gravedad (no entregadas primero)", () => {
    const subs = [
      sub("e1", "u1", 1),
      sub("e2", "u1", 1),
      sub("e3", "u1", 1),
      sub("e4", "u2", 4),
      sub("e5", "u2", 4),
      sub("e6", "u2", 4),
    ];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.reasons[0].kind).toBe("no_entregadas");
    // Y los otros dos también están (reprobadas + promedio bajo)
    expect(kinds(r)).toContain("reprobadas");
    expect(kinds(r)).toContain("promedio_bajo");
  });

  it("el estudiante que no entregó NADA queda cubierto", () => {
    // El caso más importante de todos: no tiene ninguna fila de entrega.
    const subs = [sub("e1", "u2", 4), sub("e2", "u2", 4), sub("e3", "u2", 4)];
    const r = classifyStudent("u1", subs, [], [], course);
    expect(r.missingCount).toBe(3);
    expect(r.gradedCount).toBe(0);
    expect(kinds(r)).toContain("no_entregadas");
  });
});

describe("classifyCourse", () => {
  const enrolled = new Set(["u1", "u2", "u3"]);

  it("clasifica a todos los matriculados", () => {
    const subs = [sub("e1", "u1", 4), sub("e1", "u2", 4), sub("e1", "u3", 4)];
    const out = classifyCourse(enrolled, subs, [], [], course);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.userId))).toEqual(enrolled);
  });

  it("ordena de mayor a menor riesgo", () => {
    const subs = [
      // u1 al día
      sub("e1", "u1", 5),
      sub("e2", "u1", 5),
      sub("e3", "u1", 5),
      // u2 reprobó todo (reprobadas + promedio bajo → riesgo)
      sub("e1", "u2", 1),
      sub("e2", "u2", 1),
      sub("e3", "u2", 1),
      // u3 no entregó nada (una señal → observación)
    ];
    const out = classifyCourse(enrolled, subs, [], [], course);
    expect(out[0].userId).toBe("u2");
    expect(out[0].level).toBe("en_riesgo");
    expect(out[1].userId).toBe("u3");
    expect(out[1].level).toBe("en_observacion");
    expect(out[2].userId).toBe("u1");
    expect(out[2].level).toBe("sin_riesgo");
  });

  it("un estudiante desmatriculado no aparece aunque tenga entregas", () => {
    const subs = [sub("e1", "u1", 4), sub("e1", "zz", 1)];
    const out = classifyCourse(new Set(["u1"]), subs, [], [], course);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe("u1");
  });

  it("curso sin matriculados → lista vacía", () => {
    expect(classifyCourse(new Set(), [], [], [], course)).toEqual([]);
  });

  it("un curso exigente NO pinta a todos en rojo con una sola señal", () => {
    // La razón de ser del diseño: 3 estudiantes reprueban el mismo parcial
    // difícil, pero asisten y entregan todo. Ninguno debe llegar a rojo.
    const subs = [
      sub("e1", "u1", 2.9),
      sub("e1", "u2", 2.8),
      sub("e1", "u3", 2.5),
    ];
    const sessions = [session("s1")];
    const records = [
      rec("s1", "u1", "presente"),
      rec("s1", "u2", "presente"),
      rec("s1", "u3", "presente"),
    ];
    const out = classifyCourse(enrolled, subs, sessions, records, course);
    expect(out.every((r) => r.level !== "en_riesgo")).toBe(true);
    // Cada uno tiene solo el motivo de promedio bajo.
    expect(out.every((r) => kinds(r).length === 1)).toBe(true);
  });
});

describe("summarizeRisk", () => {
  it("cuenta por nivel", () => {
    const enrolled = new Set(["u1", "u2", "u3"]);
    const subs = [sub("e1", "u1", 5), sub("e2", "u1", 5), sub("e3", "u1", 5)];
    const out = summarizeRisk(classifyCourse(enrolled, subs, [], [], course));
    expect(out.sin_riesgo).toBe(1);
    expect(out.en_observacion + out.en_riesgo).toBe(2);
  });

  it("lista vacía → todo en cero (no undefined)", () => {
    expect(summarizeRisk([])).toEqual({
      sin_riesgo: 0,
      en_observacion: 0,
      en_riesgo: 0,
    });
  });
});

describe("thresholdsFromSettings", () => {
  it("fila null → defaults", () => {
    expect(thresholdsFromSettings(null)).toEqual(DEFAULT_RISK_THRESHOLDS);
  });

  it("cae a default campo por campo (institución a medio configurar)", () => {
    const out = thresholdsFromSettings({
      early_alert_min_attendance_rate: 0.5,
      early_alert_max_failed: null,
      early_alert_max_missing: undefined,
    });
    expect(out.minAttendanceRate).toBe(0.5);
    expect(out.maxFailedActivities).toBe(
      DEFAULT_RISK_THRESHOLDS.maxFailedActivities,
    );
    expect(out.maxMissingActivities).toBe(
      DEFAULT_RISK_THRESHOLDS.maxMissingActivities,
    );
  });

  it("respeta el 0 explícito (no lo confunde con ausente)", () => {
    // `?? ` y no `||`: un umbral de 0 reprobadas toleradas es una
    // configuración válida y estricta, no un campo vacío.
    const out = thresholdsFromSettings({
      early_alert_max_failed: 0,
      early_alert_max_missing: 0,
    });
    expect(out.maxFailedActivities).toBe(0);
    expect(out.maxMissingActivities).toBe(0);
  });
});
