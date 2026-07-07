import { supabase } from "@/integrations/supabase/client";

/**
 * Helpers compartidos para el módulo de Estadísticas (docente + admin).
 *
 * El cálculo es 100% client-side a partir de las tablas existentes:
 *   - submissions (exámenes), workshop_submissions, project_submissions
 *   - attendance_sessions + attendance_records
 *   - similarity_pairs (plagio detectado)
 *   - course_enrollments
 *   - exams / workshops / projects (para metadatos: cut_id, max_score, course_id)
 *   - grade_cuts (para tendencia por corte)
 *   - courses (passing_grade, grade_scale_min/max)
 *
 * Las funciones exportadas son puras: reciben los datasets crudos y
 * retornan series listas para Recharts (`{ name, value, ... }`). La carga
 * se hace una vez por curso/global y los memos transforman a series.
 */

// ─── Tipos ────────────────────────────────────────────────────────────

export type SubmissionLike = {
  id: string;
  user_id: string;
  status: string | null;
  ai_grade: number | null;
  // exámenes usan final_override_grade; talleres/proyectos usan final_grade
  final_grade: number | null;
  ai_detected: boolean | null;
  ai_detected_score: number | null;
  ref_id: string;
  course_id: string;
  cut_id: string | null;
  max_score: number;
  is_external: boolean;
};

export type AttendanceSession = {
  id: string;
  course_id: string;
  session_date: string;
  cut_id: string | null;
};

export type AttendanceRecord = {
  session_id: string;
  user_id: string;
  status: string;
};

export type Cut = {
  id: string;
  course_id: string;
  name: string;
  position: number;
};

export type Enrollment = { course_id: string; user_id: string };

export type SimilarityPair = {
  kind: "exam" | "workshop" | "project";
  ref_id: string;
  score: number;
  user_a: string;
  user_b: string;
};

export type CourseInfo = {
  id: string;
  name: string;
  period: string | null;
  passing_grade: number;
  grade_scale_min: number;
  grade_scale_max: number;
};

export type CourseDataset = {
  course: CourseInfo;
  examSubs: SubmissionLike[];
  workshopSubs: SubmissionLike[];
  projectSubs: SubmissionLike[];
  attendanceSessions: AttendanceSession[];
  attendanceRecords: AttendanceRecord[];
  similarityPairs: SimilarityPair[];
  enrollments: Enrollment[];
  cuts: Cut[];
};

// ─── Loaders ──────────────────────────────────────────────────────────

/**
 * Carga TODO lo necesario para el dashboard de estadísticas de un curso.
 * Se hace en paralelo (8 queries) para minimizar latencia.
 */
export async function loadCourseDataset(courseId: string): Promise<CourseDataset> {
  const [
    { data: course },
    { data: examsRaw },
    { data: workshopsRaw },
    { data: projectsRaw },
    { data: cutsRaw },
    { data: enrollmentsRaw },
    { data: attendanceSessionsRaw },
  ] = await Promise.all([
    supabase
      .from("courses")
      .select("id, name, period, passing_grade, grade_scale_min, grade_scale_max")
      .eq("id", courseId)
      .single(),
    // Excluir drafts del cálculo estadístico: un examen/taller/proyecto
    // en borrador todavía no se considera parte del progreso del curso.
    // Closed sí cuenta — fue una actividad real que se cerró.
    supabase
      // `exams` NO tiene columna max_score (a diferencia de workshops/projects):
      // seleccionarla daba PostgREST 400 → TODOS los exámenes desaparecían de las
      // estadísticas en silencio. Las notas de examen ya están en la escala del
      // curso, así que abajo fijamos max_score = grade_scale_max (reescalado identidad).
      .from("exams")
      .select("id, course_id, cut_id, is_external, status")
      .eq("course_id", courseId)
      .neq("status", "draft")
      .is("deleted_at", null),
    supabase
      .from("workshops")
      .select("id, course_id, cut_id, max_score, is_external, status")
      .eq("course_id", courseId)
      .neq("status", "draft")
      .is("deleted_at", null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("projects")
      .select("id, course_id, cut_id, max_score, is_external, status")
      .eq("course_id", courseId)
      .neq("status", "draft")
      .is("deleted_at", null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("grade_cuts")
      .select("id, course_id, name, position")
      .eq("course_id", courseId)
      .order("position"),
    supabase.from("course_enrollments").select("course_id, user_id").eq("course_id", courseId),
    // attendance_sessions.cut_id es columna reciente (migración 20260509020000),
    // los types auto-generados pueden no tenerla aún hasta el próximo Publish.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("attendance_sessions")
      .select("id, course_id, session_date, cut_id")
      .eq("course_id", courseId)
      .is("deleted_at", null),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exams = (examsRaw ?? []) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workshops = (workshopsRaw ?? []) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projects = (projectsRaw ?? []) as any[];

  const examIds = exams.map((e) => e.id);
  const workshopIds = workshops.map((w) => w.id);
  const projectIds = projects.map((p) => p.id);

  // Submissions + similarity en paralelo. Plagio entre estudiantes vive
  // en `similarity_pairs` con `kind` discriminando el tipo de actividad.
  const [
    { data: examSubsRaw },
    { data: workshopSubsRaw },
    { data: projectSubsRaw },
    { data: similarityRaw },
    { data: attendanceRecordsRaw },
  ] = await Promise.all([
    examIds.length
      ? supabase
          .from("submissions")
          .select(
            "id, exam_id, user_id, status, ai_grade, final_override_grade, ai_detected, ai_detected_score",
          )
          .in("exam_id", examIds)
      : Promise.resolve({ data: [] }),
    workshopIds.length
      ? supabase
          .from("workshop_submissions")
          .select(
            "id, workshop_id, user_id, status, ai_grade, final_grade, ai_detected, ai_detected_score",
          )
          .in("workshop_id", workshopIds)
      : Promise.resolve({ data: [] }),
    projectIds.length
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("project_submissions")
          .select(
            "id, project_id, user_id, status, ai_grade, final_grade, ai_detected, ai_detected_score",
          )
          .in("project_id", projectIds)
      : Promise.resolve({ data: [] }),
    examIds.length || workshopIds.length || projectIds.length
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("similarity_pairs")
          .select("kind, ref_id, score, user_a, user_b")
          .in("ref_id", [...examIds, ...workshopIds, ...projectIds])
      : Promise.resolve({ data: [] }),
    (attendanceSessionsRaw ?? []).length
      ? supabase
          .from("attendance_records")
          .select("session_id, user_id, status")
          .in(
            "session_id",
            (attendanceSessionsRaw ?? []).map((s: { id: string }) => s.id),
          )
      : Promise.resolve({ data: [] }),
  ]);

  // Normalizar las 3 fuentes a SubmissionLike: traer cut_id/max_score/is_external
  // de la actividad padre via join client-side.
  const examMap = new Map(exams.map((e) => [e.id, e]));
  const wsMap = new Map(workshops.map((w) => [w.id, w]));
  const prMap = new Map(projects.map((p) => [p.id, p]));

  const examSubs: SubmissionLike[] = ((examSubsRaw ?? []) as Array<Record<string, unknown>>).map(
    (s) => {
      const parent = examMap.get(s.exam_id as string);
      return {
        id: String(s.id),
        user_id: String(s.user_id),
        status: (s.status as string) ?? null,
        ai_grade: (s.ai_grade as number | null) ?? null,
        final_grade: (s.final_override_grade as number | null) ?? null,
        ai_detected: (s.ai_detected as boolean | null) ?? null,
        ai_detected_score: (s.ai_detected_score as number | null) ?? null,
        ref_id: String(s.exam_id),
        course_id: parent?.course_id ?? courseId,
        cut_id: parent?.cut_id ?? null,
        // Examen no tiene max_score propio; su nota ya está en la escala del curso.
        // Fijar a grade_scale_max hace que el reescalado (g/max)*scale sea identidad.
        max_score: Number(course?.grade_scale_max ?? 1),
        is_external: !!parent?.is_external,
      };
    },
  );

  const workshopSubs: SubmissionLike[] = (
    (workshopSubsRaw ?? []) as Array<Record<string, unknown>>
  ).map((s) => {
    const parent = wsMap.get(s.workshop_id as string);
    return {
      id: String(s.id),
      user_id: String(s.user_id),
      status: (s.status as string) ?? null,
      ai_grade: (s.ai_grade as number | null) ?? null,
      final_grade: (s.final_grade as number | null) ?? null,
      ai_detected: (s.ai_detected as boolean | null) ?? null,
      ai_detected_score: (s.ai_detected_score as number | null) ?? null,
      ref_id: String(s.workshop_id),
      course_id: parent?.course_id ?? courseId,
      cut_id: parent?.cut_id ?? null,
      // Actividad EXTERNA: su nota se registra en la ESCALA DEL CURSO (0..grade_scale_max),
      // no sobre max_score (ver ExternalGradesEditor). Fijar max_score = grade_scale_max hace
      // que el reescalado (g/max)*courseMax sea identidad — igual que exámenes. Sin esto, una
      // nota externa 4,5 se distorsionaba a (4,5/100)*5 = 0,225.
      max_score: parent?.is_external
        ? Number(course?.grade_scale_max ?? 1)
        : Number(parent?.max_score ?? 100),
      is_external: !!parent?.is_external,
    };
  });

  const projectSubs: SubmissionLike[] = (
    (projectSubsRaw ?? []) as Array<Record<string, unknown>>
  ).map((s) => {
    const parent = prMap.get(s.project_id as string);
    return {
      id: String(s.id),
      user_id: String(s.user_id),
      status: (s.status as string) ?? null,
      ai_grade: (s.ai_grade as number | null) ?? null,
      final_grade: (s.final_grade as number | null) ?? null,
      ai_detected: (s.ai_detected as boolean | null) ?? null,
      ai_detected_score: (s.ai_detected_score as number | null) ?? null,
      ref_id: String(s.project_id),
      course_id: parent?.course_id ?? courseId,
      cut_id: parent?.cut_id ?? null,
      // Externa → nota en escala del curso; reescalado identidad (ver workshopSubs arriba).
      max_score: parent?.is_external
        ? Number(course?.grade_scale_max ?? 1)
        : Number(parent?.max_score ?? 100),
      is_external: !!parent?.is_external,
    };
  });

  return {
    course: course as CourseInfo,
    examSubs,
    workshopSubs,
    projectSubs,
    attendanceSessions: (attendanceSessionsRaw ?? []) as AttendanceSession[],
    attendanceRecords: (attendanceRecordsRaw ?? []) as AttendanceRecord[],
    similarityPairs: (similarityRaw ?? []) as SimilarityPair[],
    enrollments: (enrollmentsRaw ?? []) as Enrollment[],
    cuts: (cutsRaw ?? []) as Cut[],
  };
}

// ─── Cálculos ─────────────────────────────────────────────────────────

/** Nota efectiva de una submission, en escala del item (0..max_score).
 *  Prioriza override del docente (final_grade) sobre IA. */
export function effectiveGrade(s: SubmissionLike): number | null {
  if (s.final_grade != null) return Number(s.final_grade);
  if (s.ai_grade != null) return Number(s.ai_grade);
  return null;
}

/** Aprobación normalizada a la escala del curso. Cada submission con
 *  nota tiene su `max_score` propio (puede diferir de la escala del
 *  curso); reescalamos antes de comparar contra `passing_grade`. */
export function isApproved(s: SubmissionLike, course: CourseInfo): boolean | null {
  const g = effectiveGrade(s);
  if (g == null) return null;
  // Reescalar al rango del curso para comparar con passing_grade
  const max = s.max_score || 1;
  const courseMax = course.grade_scale_max || max;
  const scaled = (g / max) * courseMax;
  return scaled >= course.passing_grade;
}

/** {approved, failed, pending, total} para un set de submissions vs los
 *  matriculados. `pending` = matriculados sin entrega o con status que
 *  no implica nota. */
export function computeApproval(
  subs: SubmissionLike[],
  enrolledIds: Set<string>,
  course: CourseInfo,
): { approved: number; failed: number; pending: number; total: number } {
  const subByUser = new Map<string, SubmissionLike>();
  for (const s of subs) {
    // Si el mismo user tiene varias entregas para el mismo ref (re-entrega
    // por ej.), nos quedamos con la que tiene nota. Si todas no la tienen,
    // queda la última.
    const key = `${s.ref_id}::${s.user_id}`;
    const prev = subByUser.get(key);
    if (!prev || effectiveGrade(s) != null) subByUser.set(key, s);
  }
  let approved = 0;
  let failed = 0;
  let pending = 0;
  // Iteramos por (refId, user) — pero para el % global del curso lo más
  // útil es: por matriculado, ¿cuántas actividades aprobó vs reprobó?
  // Simplificamos: contamos celdas (matriculado × actividad).
  const refIds = new Set(subs.map((s) => s.ref_id));
  const total = refIds.size * enrolledIds.size;
  for (const refId of refIds) {
    for (const uid of enrolledIds) {
      const s = subByUser.get(`${refId}::${uid}`);
      if (!s) {
        pending++;
        continue;
      }
      const ok = isApproved(s, course);
      if (ok == null) pending++;
      else if (ok) approved++;
      else failed++;
    }
  }
  return { approved, failed, pending, total };
}

/** Estudiantes que PERDIERON: matriculados con al menos una entrega
 *  calificada cuya nota (reescalada a la escala del curso) quedó por
 *  DEBAJO del `passing_grade`. Cuenta estudiantes ÚNICOS, no celdas —
 *  un estudiante que reprueba dos exámenes cuenta una sola vez.
 *
 *  Solo se consideran matriculados (`enrolledIds`): una entrega de un
 *  estudiante ya desmatriculado no debe contar. Usa el mismo `isApproved`
 *  que el resto del módulo (reescala max_score → escala del curso). */
export function computeFailedStudents(
  subs: SubmissionLike[],
  enrolledIds: Set<string>,
  course: CourseInfo,
): { failed: number; ids: string[] } {
  const ids = new Set<string>();
  for (const s of subs) {
    if (!enrolledIds.has(s.user_id)) continue;
    if (isApproved(s, course) === false) ids.add(s.user_id);
  }
  return { failed: ids.size, ids: [...ids] };
}

/** Estudiantes que NO PRESENTARON: matriculados sin NINGUNA entrega en el
 *  set de submissions dado. Cuenta estudiantes ÚNICOS.
 *
 *  Distinto de "pendiente" en computeApproval (que mezcla "no presentó"
 *  con "presentó pero sin nota aún"): acá solo cuenta la AUSENCIA total
 *  de entrega. Un estudiante con entrega sin calificar NO se cuenta como
 *  "no presentó" — sí presentó, falta calificarla. */
export function computeNoPresentedStudents(
  subs: SubmissionLike[],
  enrolledIds: Set<string>,
): { notPresented: number; ids: string[] } {
  const withSubmission = new Set<string>();
  for (const s of subs) {
    if (enrolledIds.has(s.user_id)) withSubmission.add(s.user_id);
  }
  const ids: string[] = [];
  for (const uid of enrolledIds) {
    if (!withSubmission.has(uid)) ids.push(uid);
  }
  return { notPresented: ids.length, ids };
}

/** Distribución de notas en buckets. Retorna 5 buckets para escala 0-5
 *  (o equivalente). Cada nota se reescala al rango del curso. */
export function computeGradeDistribution(
  subs: SubmissionLike[],
  course: CourseInfo,
): Array<{ range: string; count: number }> {
  const min = course.grade_scale_min ?? 0;
  const max = course.grade_scale_max ?? 5;
  const span = max - min;
  const bucketCount = 5;
  const bucketSize = span / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const lo = min + i * bucketSize;
    const hi = i === bucketCount - 1 ? max : min + (i + 1) * bucketSize;
    return {
      range: `${formatBucket(lo)}–${formatBucket(hi)}`,
      lo,
      hi,
      count: 0,
    };
  });
  for (const s of subs) {
    const g = effectiveGrade(s);
    if (g == null) continue;
    const courseMax = course.grade_scale_max || s.max_score || 1;
    const itemMax = s.max_score || 1;
    const scaled = (g / itemMax) * courseMax;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((scaled - min) / bucketSize)));
    buckets[idx].count++;
  }
  return buckets.map(({ range, count }) => ({ range, count }));
}

function formatBucket(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
}

/** Tasa de fraude IA: % de entregas con `ai_detected_score >= 0.6`. */
export function computeFraudStats(
  subs: SubmissionLike[],
  similarity: SimilarityPair[],
): {
  aiSuspect: number;
  totalGraded: number;
  plagiarismPairs: number;
  plagiarismStudents: number;
} {
  const graded = subs.filter((s) => s.ai_detected_score != null);
  const aiSuspect = graded.filter((s) => (s.ai_detected_score ?? 0) >= 0.6).length;
  const plagiarismPairs = similarity.filter((p) => p.score >= 0.6).length;
  const studentSet = new Set<string>();
  for (const p of similarity) {
    if (p.score >= 0.6) {
      studentSet.add(p.user_a);
      studentSet.add(p.user_b);
    }
  }
  return {
    aiSuspect,
    totalGraded: graded.length,
    plagiarismPairs,
    plagiarismStudents: studentSet.size,
  };
}

/** % asistencia por sesión (ordenadas por fecha). */
export function computeAttendanceBySession(
  sessions: AttendanceSession[],
  records: AttendanceRecord[],
  totalEnrolled: number,
): Array<{ date: string; presentPct: number; presentCount: number; total: number }> {
  if (totalEnrolled === 0) return [];
  return [...sessions]
    .sort((a, b) => a.session_date.localeCompare(b.session_date))
    .map((s) => {
      const present = records.filter(
        (r) => r.session_id === s.id && r.status === "presente",
      ).length;
      return {
        date: s.session_date,
        presentCount: present,
        total: totalEnrolled,
        presentPct: Math.round((present / totalEnrolled) * 100),
      };
    });
}

/** Nota promedio del curso por corte. Combina exámenes/talleres/proyectos
 *  reescalados a la escala del curso. */
export function computeCutTrend(
  examSubs: SubmissionLike[],
  workshopSubs: SubmissionLike[],
  projectSubs: SubmissionLike[],
  cuts: Cut[],
  course: CourseInfo,
): Array<{ cut: string; avg: number | null }> {
  const all = [...examSubs, ...workshopSubs, ...projectSubs];
  return cuts.map((cut) => {
    const inCut = all.filter((s) => s.cut_id === cut.id);
    const grades = inCut
      .map((s) => {
        const g = effectiveGrade(s);
        if (g == null) return null;
        const max = s.max_score || 1;
        const courseMax = course.grade_scale_max || max;
        return (g / max) * courseMax;
      })
      .filter((g): g is number => g != null);
    return {
      cut: cut.name,
      avg:
        grades.length === 0
          ? null
          : Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 100) / 100,
    };
  });
}

/** Aprobación apilada por tipo de actividad: { kind, approved, failed, pending }. */
export function computeApprovalByKind(
  ds: CourseDataset,
): Array<{ kind: string; approved: number; failed: number; pending: number }> {
  const enrolledIds = new Set(ds.enrollments.map((e) => e.user_id));
  const result: Array<{ kind: string; approved: number; failed: number; pending: number }> = [];
  for (const [label, subs] of [
    ["Exámenes", ds.examSubs],
    ["Talleres", ds.workshopSubs],
    ["Proyectos", ds.projectSubs],
  ] as const) {
    const r = computeApproval(subs, enrolledIds, ds.course);
    result.push({ kind: label, approved: r.approved, failed: r.failed, pending: r.pending });
  }
  return result;
}
