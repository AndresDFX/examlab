/**
 * Alerta temprana: clasifica el riesgo de deserción/pérdida de cada
 * estudiante matriculado en un curso.
 *
 * Consume el `CourseDataset` que ya carga `statistics.ts` — no hace queries
 * propias, así que el panel del docente no cuesta ni una consulta extra.
 *
 * ── Por qué "motivos" y no un puntaje ──────────────────────────────────
 * La tentación es un score 0..100. Se descartó: un número opaco no le dice
 * al docente QUÉ hacer, y cuando no entiende de dónde salió deja de creerle.
 * Acá cada estudiante acumula MOTIVOS discretos y verificables ("faltó al
 * 40% de las clases", "no entregó 3 actividades") y el nivel se deriva de
 * cuántos motivos distintos se cruzaron.
 *
 * Consecuencia deliberada: hacen falta DOS señales independientes para
 * llegar a rojo. Un curso exigente donde media clase reprobó un parcial no
 * pinta media clase en rojo — que es lo que hace que un semáforo se deje de
 * mirar a las dos semanas.
 */

import {
  effectiveGrade,
  isApproved,
  type AttendanceRecord,
  type AttendanceSession,
  type CourseInfo,
  type SubmissionLike,
} from "./statistics";

// ─── Tipos ────────────────────────────────────────────────────────────

/** Orden intencional: de menor a mayor gravedad (se usa para ordenar). */
export const RISK_LEVELS = ["sin_riesgo", "en_observacion", "en_riesgo"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export type RiskReasonKind = "inasistencia" | "reprobadas" | "no_entregadas" | "promedio_bajo";

export type RiskReason = {
  kind: RiskReasonKind;
  /** Valor observado. Tasa 0..1 para inasistencia, conteo para el resto,
   *  nota en escala del curso para promedio_bajo. */
  value: number;
  /** Umbral que se cruzó. Se guarda para poder explicar el motivo sin que
   *  la UI tenga que volver a leer la configuración. */
  threshold: number;
};

export type RiskThresholds = {
  /** Tasa mínima de asistencia aceptable (0..1). Por debajo, motivo. */
  minAttendanceRate: number;
  /** Cantidad de actividades reprobadas que se tolera SIN motivo. */
  maxFailedActivities: number;
  /** Cantidad de actividades no entregadas que se tolera SIN motivo. */
  maxMissingActivities: number;
};

/**
 * Defaults conservadores: preferimos no marcar a nadie antes que marcar a
 * medio curso. Cada institución los ajusta en Configuración → General.
 *
 * `maxFailed`/`maxMissing` en 2 (no en 1) porque una sola actividad floja
 * es ruido normal de un semestre, no una señal de deserción.
 */
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  minAttendanceRate: 0.75,
  maxFailedActivities: 2,
  maxMissingActivities: 2,
};

export type StudentRisk = {
  userId: string;
  level: RiskLevel;
  /** Ordenados por gravedad según `REASON_SEVERITY`. */
  reasons: RiskReason[];
  /** null cuando el curso no registró asistencia para este estudiante —
   *  ausencia de dato, NO 0% de asistencia. */
  attendanceRate: number | null;
  absentCount: number;
  /** Sesiones que cuentan para la tasa (excluye las justificadas). */
  attendanceConsidered: number;
  failedCount: number;
  missingCount: number;
  /** Promedio en la escala del curso. null si no tiene nada calificado. */
  averageGrade: number | null;
  gradedCount: number;
};

// ─── Reglas ───────────────────────────────────────────────────────────

/** Para ordenar los motivos dentro de un estudiante: primero lo que más
 *  acción del docente amerita. */
const REASON_SEVERITY: Record<RiskReasonKind, number> = {
  no_entregadas: 0,
  inasistencia: 1,
  reprobadas: 2,
  promedio_bajo: 3,
};

/**
 * Asistencia efectiva de un estudiante.
 *
 * Tres decisiones que buscan no castigar injustamente:
 *  - `tarde` cuenta como que ASISTIÓ. Llegar tarde es un tema de
 *    disciplina, no una señal de deserción; contarlo como ausencia infla
 *    el rojo con estudiantes que sí están yendo a clase.
 *  - `justificado` sale del denominador. Una ausencia con excusa no puede
 *    empujar a nadie al semáforo rojo — es el error que más rápido hace
 *    que un docente deje de confiar en la herramienta.
 *  - Solo cuentan las sesiones donde el estudiante TIENE registro. Si el
 *    docente no tomó asistencia, no hay filas y tratar "sin registro" como
 *    ausente marcaría al curso entero.
 */
export function computeStudentAttendance(
  userId: string,
  sessions: AttendanceSession[],
  records: AttendanceRecord[],
): { rate: number | null; absent: number; considered: number } {
  const sessionIds = new Set(sessions.map((s) => s.id));
  let attended = 0;
  let absent = 0;
  for (const r of records) {
    if (r.user_id !== userId) continue;
    // Un registro de una sesión que no pertenece al curso (o que se borró)
    // no debe contar.
    if (!sessionIds.has(r.session_id)) continue;
    if (r.status === "presente" || r.status === "tarde") attended++;
    else if (r.status === "ausente") absent++;
    // `justificado` (y cualquier estado futuro) se ignora a propósito.
  }
  const considered = attended + absent;
  return {
    rate: considered === 0 ? null : attended / considered,
    absent,
    considered,
  };
}

/** Nota reescalada a la escala del curso, o null si no tiene nota. */
function scaledGrade(s: SubmissionLike, course: CourseInfo): number | null {
  const g = effectiveGrade(s);
  if (g == null) return null;
  const max = s.max_score || 1;
  const courseMax = course.grade_scale_max || max;
  return (g / max) * courseMax;
}

/**
 * Clasifica a UN estudiante.
 *
 * `allSubs` son todas las entregas del curso (exámenes + talleres +
 * proyectos), porque el universo de actividades se deriva de ahí.
 */
export function classifyStudent(
  userId: string,
  allSubs: SubmissionLike[],
  sessions: AttendanceSession[],
  records: AttendanceRecord[],
  course: CourseInfo,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): StudentRisk {
  // ── Universo de actividades ──
  // Se deriva de las entregas existentes. Limitación conocida: una
  // actividad que NADIE entregó no aparece acá, así que no se cuenta como
  // "no entregada". Es aceptable porque en ese caso el faltante es igual
  // para todo el curso y no distingue a nadie — y el caso que importa
  // (todos entregaron menos este) sí queda cubierto.
  const refIds = new Set(allSubs.map((s) => s.ref_id));

  // Quedarse con UNA entrega por (actividad, estudiante), prefiriendo la
  // que tiene nota. Misma regla que `computeApproval` para que los números
  // del panel de riesgo y los de estadísticas no se contradigan.
  const mine = new Map<string, SubmissionLike>();
  for (const s of allSubs) {
    if (s.user_id !== userId) continue;
    const prev = mine.get(s.ref_id);
    if (!prev || effectiveGrade(s) != null) mine.set(s.ref_id, s);
  }

  let failedCount = 0;
  let gradedCount = 0;
  let gradeSum = 0;
  for (const s of mine.values()) {
    if (isApproved(s, course) === false) failedCount++;
    const g = scaledGrade(s, course);
    if (g != null) {
      gradedCount++;
      gradeSum += g;
    }
  }

  let missingCount = 0;
  for (const refId of refIds) {
    if (!mine.has(refId)) missingCount++;
  }

  const attendance = computeStudentAttendance(userId, sessions, records);
  const averageGrade = gradedCount === 0 ? null : gradeSum / gradedCount;

  // ── Motivos ──
  const reasons: RiskReason[] = [];

  if (attendance.rate != null && attendance.rate < thresholds.minAttendanceRate) {
    reasons.push({
      kind: "inasistencia",
      value: attendance.rate,
      threshold: thresholds.minAttendanceRate,
    });
  }
  if (failedCount > thresholds.maxFailedActivities) {
    reasons.push({
      kind: "reprobadas",
      value: failedCount,
      threshold: thresholds.maxFailedActivities,
    });
  }
  if (missingCount > thresholds.maxMissingActivities) {
    reasons.push({
      kind: "no_entregadas",
      value: missingCount,
      threshold: thresholds.maxMissingActivities,
    });
  }
  // El promedio no tiene umbral configurable: la nota de aprobación del
  // curso YA es el umbral que la institución definió. Inventar otro sería
  // pedirle al Admin que configure dos veces lo mismo.
  if (averageGrade != null && averageGrade < course.passing_grade) {
    reasons.push({
      kind: "promedio_bajo",
      value: averageGrade,
      threshold: course.passing_grade,
    });
  }

  reasons.sort((a, b) => REASON_SEVERITY[a.kind] - REASON_SEVERITY[b.kind]);

  return {
    userId,
    level: levelForReasons(reasons.length),
    reasons,
    attendanceRate: attendance.rate,
    absentCount: attendance.absent,
    attendanceConsidered: attendance.considered,
    failedCount,
    missingCount,
    averageGrade,
    gradedCount,
  };
}

/**
 * Nivel según CUÁNTOS motivos distintos se cruzaron.
 *
 * Que hagan falta 2 señales independientes para el rojo es el corazón del
 * diseño: evita que un curso exigente (donde muchos reprueban un parcial)
 * amanezca con media clase en rojo y el docente deje de mirar el panel.
 */
export function levelForReasons(count: number): RiskLevel {
  if (count <= 0) return "sin_riesgo";
  if (count === 1) return "en_observacion";
  return "en_riesgo";
}

/** Clasifica a TODOS los matriculados, de mayor a menor riesgo. */
export function classifyCourse(
  enrolledIds: Set<string>,
  allSubs: SubmissionLike[],
  sessions: AttendanceSession[],
  records: AttendanceRecord[],
  course: CourseInfo,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): StudentRisk[] {
  const out: StudentRisk[] = [];
  for (const uid of enrolledIds) {
    out.push(classifyStudent(uid, allSubs, sessions, records, course, thresholds));
  }
  // Más riesgo primero; a igual nivel, más motivos primero; luego por
  // promedio ascendente para que arriba quede el caso más urgente.
  const rank = (l: RiskLevel) => RISK_LEVELS.indexOf(l);
  out.sort((a, b) => {
    const byLevel = rank(b.level) - rank(a.level);
    if (byLevel !== 0) return byLevel;
    const byReasons = b.reasons.length - a.reasons.length;
    if (byReasons !== 0) return byReasons;
    const ag = a.averageGrade ?? Number.POSITIVE_INFINITY;
    const bg = b.averageGrade ?? Number.POSITIVE_INFINITY;
    return ag - bg;
  });
  return out;
}

/** Conteo por nivel, para las tarjetas de resumen. */
export function summarizeRisk(risks: StudentRisk[]): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = {
    sin_riesgo: 0,
    en_observacion: 0,
    en_riesgo: 0,
  };
  for (const r of risks) out[r.level]++;
  return out;
}

/** Lee los umbrales de una fila de `app_settings`, cayendo a los defaults
 *  campo por campo (una institución sin configurar no rompe nada). */
export function thresholdsFromSettings(
  row: {
    early_alert_min_attendance_rate?: number | null;
    early_alert_max_failed?: number | null;
    early_alert_max_missing?: number | null;
  } | null,
): RiskThresholds {
  return {
    minAttendanceRate:
      row?.early_alert_min_attendance_rate ?? DEFAULT_RISK_THRESHOLDS.minAttendanceRate,
    maxFailedActivities: row?.early_alert_max_failed ?? DEFAULT_RISK_THRESHOLDS.maxFailedActivities,
    maxMissingActivities:
      row?.early_alert_max_missing ?? DEFAULT_RISK_THRESHOLDS.maxMissingActivities,
  };
}
