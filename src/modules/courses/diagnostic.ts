/**
 * Helpers PUROS para el Diagnóstico del curso.
 *
 * El dialog `CourseDiagnosticDialog` se monta sobre estos helpers para
 * resumir entregas pendientes / con error / calificadas, sin
 * dependencias React ni Supabase. Permite test exhaustivo sin mocks.
 */

/** Un item evaluativo (examen, taller o proyecto) que cuenta para la
 *  matriz "estudiante × actividad" del diagnóstico. */
export type DiagItem = {
  id: string;
  title: string;
  kind: "exam" | "workshop" | "project";
};

/** Un estudiante matriculado en el curso. */
export type DiagStudent = {
  id: string;
  full_name: string | null;
  institutional_email: string | null;
  /** Cohorte del estudiante (campo libre en profiles). Cuando el curso
   *  agrupa por cohortes, se usa para detectar actividades que olvidaron
   *  asignarse a alguna cohorte. */
  cohorte?: string | null;
};

/** Una entrega (submission) genérica. Cubre las 3 tablas:
 *  - submissions (examen): ai_grade, final_override_grade.
 *  - workshop_submissions: ai_grade, final_grade.
 *  - project_submissions: ai_grade, final_grade.
 *
 *  El campo `has_final_grade` colapsa esa diferencia: true cuando hay
 *  cualquier nota persistida (override del docente, ai_grade ya
 *  aplicado, o final_grade en workshops/proyectos).
 */
export type DiagSubmission = {
  user_id: string;
  item_id: string;
  item_kind: "exam" | "workshop" | "project";
  /** `status` crudo de la tabla. Posibles: iniciado, en_progreso,
   *  entregado, calificado, sospechoso, requiere_revision, etc. */
  status: string | null;
  /** ¿Hay alguna nota persistida ya? */
  has_final_grade: boolean;
  /** id real de la fila de submission (submissions / workshop_submissions /
   *  project_submissions). Lo necesita "Calificar todos" para encolar. */
  submission_id?: string | null;
  /** Solo proyectos: la entrega tiene nota de entrega/IA pero le falta la
   *  SUSTENTACIÓN (final_grade null + defense_at null). El docente debe
   *  registrar el factor de sustentación para cerrar la nota final. */
  defense_pending?: boolean;
};

/** Estado conceptual de la celda matriz. */
export type DiagCellStatus =
  | "sin_entregar"
  | "entregado_sin_calificar"
  | "calificado"
  | "error_ia"
  | "sin_sustentacion";

/** Una celda de la matriz: un estudiante × una actividad. */
export type DiagPendingRow = {
  student: DiagStudent;
  item: DiagItem;
  status: DiagCellStatus;
  /** ¿Tiene un job de ai_grading_queue con status=failed apuntando a
   *  esta submission? Cuando true, la celda se marca `error_ia`
   *  aunque la submission técnicamente esté "entregado". */
  hasAiError: boolean;
  /** id real de la submission (cuando existe) — para encolar IA. */
  submissionId: string | null;
};

/**
 * Construye la matriz consolidada de calificaciones pendientes.
 *
 * Reglas:
 * - Si el estudiante NO tiene submission para el item → "sin_entregar".
 * - Si hay submission + un job IA failed apuntándola → "error_ia".
 * - Si hay submission con nota persistida → "calificado".
 * - Caso contrario (entregada sin nota) → "entregado_sin_calificar".
 *
 * `aiFailedRefIds` es el set de `target_row_id` de jobs failed (lo
 * arma el caller buscando en `ai_grading_queue.status='failed'` del
 * curso). El helper no toca DB.
 */
// Estados de submission que significan "el estudiante AÚN no entregó"
// (borrador / en progreso). Una fila con uno de estos NO es una entrega real:
// no debe contar como "pendiente de calificar". Los exámenes crean la fila al
// INICIAR (status 'en_progreso') y sólo pasa a 'completado'/'sospechoso' al
// entregar; talleres/proyectos sólo crean la fila al entregar ('entregado').
const NOT_SUBMITTED_STATUSES = new Set([
  "en_progreso",
  "iniciado",
  "borrador",
  "draft",
  "pendiente",
  "no_entregado",
]);

/** ¿La submission representa una entrega REAL del estudiante? Falso para
 *  borradores / en progreso. Status nulo/desconocido → true (no ocultar
 *  pendientes legítimos por un estado inesperado). */
export function isSubmittedStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  return !NOT_SUBMITTED_STATUSES.has(status);
}

export function summarizePendingGrades(
  students: DiagStudent[],
  submissions: DiagSubmission[],
  items: DiagItem[],
  aiFailedRefIds: Set<string> = new Set(),
): DiagPendingRow[] {
  // Indexamos las submissions por (user_id, item_kind, item_id) para
  // lookups O(1) — la matriz es N×M y sin indexar sería O(N*M*subs).
  const subsByKey = new Map<string, DiagSubmission>();
  for (const s of submissions) {
    subsByKey.set(`${s.user_id}::${s.item_kind}::${s.item_id}`, s);
  }

  const rows: DiagPendingRow[] = [];
  for (const student of students) {
    for (const item of items) {
      const sub = subsByKey.get(`${student.id}::${item.kind}::${item.id}`);
      let status: DiagCellStatus;
      let hasAiError = false;

      if (!sub) {
        status = "sin_entregar";
      } else {
        // ¿Job IA en error apuntando a esta submission? Marcamos
        // primero porque el error debe ganar al estado de la fila.
        // Nota: aiFailedRefIds contiene submission_id (no item_id).
        // Como las submissions no tienen un id estable acá, el caller
        // puede pasar los user_id+item_id concatenados, o el id real
        // — ambos se soportan dependiendo de cómo arme el set.
        const submissionRef = `${sub.user_id}::${sub.item_kind}::${sub.item_id}`;
        if (aiFailedRefIds.has(submissionRef)) {
          hasAiError = true;
          status = "error_ia";
        } else if (sub.defense_pending) {
          // Proyecto calificado pero sin sustentación: la nota final no
          // cierra hasta que el docente registre el factor de sustentación.
          // Gana a "calificado" porque es accionable.
          status = "sin_sustentacion";
        } else if (sub.has_final_grade) {
          status = "calificado";
        } else if (!isSubmittedStatus(sub.status)) {
          // Borrador / en progreso (ej. examen 'en_progreso'): el estudiante
          // NO ha entregado → NO cuenta como pendiente de calificar.
          status = "sin_entregar";
        } else {
          status = "entregado_sin_calificar";
        }
      }

      rows.push({ student, item, status, hasAiError, submissionId: sub?.submission_id ?? null });
    }
  }
  return rows;
}

/** Resumen agregado de la matriz para los stats arriba del dialog. */
export type DiagSummary = {
  totalCells: number;
  sinEntregar: number;
  entregadoSinCalificar: number;
  calificado: number;
  errorIa: number;
  sinSustentacion: number;
};

export function summarizeMatrix(rows: DiagPendingRow[]): DiagSummary {
  const result: DiagSummary = {
    totalCells: rows.length,
    sinEntregar: 0,
    entregadoSinCalificar: 0,
    calificado: 0,
    errorIa: 0,
    sinSustentacion: 0,
  };
  for (const r of rows) {
    if (r.status === "sin_entregar") result.sinEntregar += 1;
    else if (r.status === "entregado_sin_calificar") result.entregadoSinCalificar += 1;
    else if (r.status === "calificado") result.calificado += 1;
    else if (r.status === "error_ia") result.errorIa += 1;
    else if (r.status === "sin_sustentacion") result.sinSustentacion += 1;
  }
  return result;
}

/** Una sesión de asistencia con sus conteos derivados. */
export type DiagAttendanceSession = {
  id: string;
  session_date: string;
  title: string | null;
  present: number;
  absent: number;
  pending: number;
};

/** Construye los conteos de asistencia para cada sesión. Una sesión
 *  con N estudiantes matriculados tiene:
 *   - presentes: records con status='presente'.
 *   - ausentes: records con status='ausente'.
 *   - pendientes: matriculados que no tienen ningún record (no se
 *     les pasó lista).
 *
 *  Los registros se enrutan al estado por `status` exacto: cualquier
 *  valor distinto a 'presente' o 'ausente' (ej. 'tarde', 'excusado')
 *  NO cuenta como ausente — preferimos under-count y dejar que el
 *  docente vea el detalle. La regla puede ajustarse si el dominio lo
 *  pide; centralizando acá el caller solo pasa rows.
 */
export function summarizeAttendance(
  sessions: Array<{ id: string; session_date: string; title: string | null }>,
  records: Array<{ session_id: string; user_id: string; status: string | null }>,
  enrolledStudentCount: number,
): DiagAttendanceSession[] {
  // Agrupamos records por sesión para evitar O(N*M).
  const bySession = new Map<string, { present: number; absent: number; userIds: Set<string> }>();
  for (const s of sessions) {
    bySession.set(s.id, { present: 0, absent: 0, userIds: new Set() });
  }
  for (const r of records) {
    const bucket = bySession.get(r.session_id);
    if (!bucket) continue;
    if (bucket.userIds.has(r.user_id)) continue; // dedup por estudiante
    bucket.userIds.add(r.user_id);
    if (r.status === "presente") bucket.present += 1;
    else if (r.status === "ausente") bucket.absent += 1;
    // status raros (tarde / excusado / null) no cuentan en ninguno.
  }
  return sessions.map((s) => {
    const b = bySession.get(s.id);
    const recorded = b ? b.userIds.size : 0;
    return {
      id: s.id,
      session_date: s.session_date,
      title: s.title,
      present: b?.present ?? 0,
      absent: b?.absent ?? 0,
      pending: Math.max(0, enrolledStudentCount - recorded),
    };
  });
}

/** Label humano para el estado de la celda — i18n se hace en la UI;
 *  acá devolvemos la clave canónica. */
export function diagCellStatusLabel(status: DiagCellStatus): string {
  switch (status) {
    case "sin_entregar":
      return "Sin entregar";
    case "entregado_sin_calificar":
      return "Entregado · sin calificar";
    case "calificado":
      return "Calificado";
    case "error_ia":
      return "Error de IA";
    case "sin_sustentacion":
      return "Falta sustentación";
  }
}

/** Una actividad a la que le falta asignar al menos una cohorte. */
export type DiagCohortGap = {
  item: DiagItem;
  /** Cohortes del curso sin NINGÚN estudiante asignado a esta actividad. */
  missingCohorts: string[];
  /** Cuántos estudiantes en total quedan fuera (suma de las cohortes faltantes). */
  affectedStudents: number;
};

export type DiagCohortCoverage = {
  /** El curso usa cohortes (hay ≥1 cohorte entre los matriculados). */
  hasCohorts: boolean;
  /** Cohortes distintas presentes entre los matriculados (ordenadas). */
  cohorts: string[];
  /** Actividades con al menos una cohorte sin asignar. Vacío = todo OK. */
  gaps: DiagCohortGap[];
};

/**
 * Detecta actividades (examen/taller/proyecto) que NO fueron asignadas a
 * alguna cohorte del curso. Como la asignación es obligatoria (un estudiante
 * solo ve lo que tiene en *_assignments), una cohorte sin ningún estudiante
 * asignado a una actividad significa que esa cohorte NO la verá — casi
 * siempre un olvido del docente al asignar.
 *
 * Helper PURO: el caller arma `assignedUserIdsByItemKey` (key = `${kind}::${id}`)
 * desde exam_assignments / workshop_assignments / project_assignments.
 *
 * Una cohorte se considera "cubierta" si AL MENOS un estudiante suyo está
 * asignado. La cobertura parcial dentro de una cohorte no se reporta acá
 * (el foco es "la cohorte completa quedó fuera").
 */
export function summarizeCohortCoverage(
  students: DiagStudent[],
  items: DiagItem[],
  assignedUserIdsByItemKey: Map<string, Set<string>>,
): DiagCohortCoverage {
  const cohorteOf = new Map<string, string>();
  for (const s of students) cohorteOf.set(s.id, (s.cohorte ?? "").trim());

  const studentsByCohort = new Map<string, string[]>();
  for (const s of students) {
    const c = cohorteOf.get(s.id) ?? "";
    if (!c) continue; // estudiantes sin cohorte no entran al análisis por cohorte
    const list = studentsByCohort.get(c);
    if (list) list.push(s.id);
    else studentsByCohort.set(c, [s.id]);
  }
  const cohorts = Array.from(studentsByCohort.keys()).sort((a, b) =>
    a.localeCompare(b, "es-CO", { numeric: true }),
  );
  const hasCohorts = cohorts.length > 0;
  if (!hasCohorts) return { hasCohorts: false, cohorts: [], gaps: [] };

  const gaps: DiagCohortGap[] = [];
  for (const item of items) {
    const assigned = assignedUserIdsByItemKey.get(`${item.kind}::${item.id}`) ?? new Set<string>();
    const missing: string[] = [];
    let affected = 0;
    for (const c of cohorts) {
      const cohortStudents = studentsByCohort.get(c) ?? [];
      const anyAssigned = cohortStudents.some((uid) => assigned.has(uid));
      if (!anyAssigned) {
        missing.push(c);
        affected += cohortStudents.length;
      }
    }
    if (missing.length > 0) {
      gaps.push({ item, missingCohorts: missing, affectedStudents: affected });
    }
  }
  return { hasCohorts: true, cohorts, gaps };
}

/** Devuelve la "severidad" para ordenar la matriz: los errores y
 *  pendientes deben aparecer ANTES de las calificadas para que el
 *  docente vea lo accionable primero sin scrollear. */
export function diagCellSeverity(status: DiagCellStatus): number {
  switch (status) {
    case "error_ia":
      return 0;
    case "entregado_sin_calificar":
      return 1;
    case "sin_sustentacion":
      return 2;
    case "sin_entregar":
      return 3;
    case "calificado":
      return 4;
  }
}
