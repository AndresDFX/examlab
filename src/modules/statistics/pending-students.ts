import { supabase } from "@/integrations/supabase/client";

/**
 * "Pendientes por estudiante" del módulo de Estadísticas del docente.
 *
 * Responde una pregunta operativa distinta de la Alerta temprana: no "a quién
 * hay que buscar por riesgo de deserción", sino "qué le falta HACER a cada
 * estudiante, ahora" — firmar un documento, responder una encuesta abierta,
 * presentar un examen, entregar un taller o un proyecto.
 *
 * A diferencia de `statistics.ts` (que carga UN curso a fondo), este loader
 * trabaja sobre un CONJUNTO de cursos para poder mostrar el agregado
 * cross-curso cuando el docente elige "Todos los cursos". Por eso vive aparte
 * y hace sus propias consultas acotadas por `courseIds`.
 *
 * `courseIds` YA viene acotado por el alcance del docente (course-scope) y por
 * el filtro de periodo/asignatura (course-filter-scope). Si viene vacío se
 * devuelve `[]` SIN consultar — un `.in(col, [])` en PostgREST devuelve TODAS
 * las filas, no ninguna.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = supabase as any;

export const PENDING_KINDS = ["firma", "encuesta", "examen", "taller", "proyecto"] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

/** Un pendiente concreto: el estudiante `userId` le debe algo de `kind` a un
 *  entregable del curso `courseId`. La agregación cuenta estos items. */
export type PendingItem = { userId: string; courseId: string; kind: PendingKind };

export type StudentPendingRow = {
  userId: string;
  name: string;
  /** Nombres de los cursos donde tiene al menos un pendiente, ordenados. */
  courses: string[];
  firma: number;
  encuesta: number;
  examen: number;
  taller: number;
  proyecto: number;
  total: number;
};

/**
 * PURO: agrupa los pendientes crudos por estudiante y resuelve nombres.
 *
 * Se extrae del loader para poder testear la agregación (conteo por tipo,
 * dedup de cursos, orden) sin montar la base. Los estudiantes SIN pendientes
 * no aparecen: un listado de 90 filas donde 85 están al día entierra a los 5
 * que importan (mismo criterio que la Alerta temprana).
 */
export function aggregatePending(
  items: readonly PendingItem[],
  names: ReadonlyMap<string, string>,
  courseNames: ReadonlyMap<string, string>,
): StudentPendingRow[] {
  const byUser = new Map<
    string,
    { counts: Record<PendingKind, number>; courseIds: Set<string> }
  >();
  for (const it of items) {
    let e = byUser.get(it.userId);
    if (!e) {
      e = { counts: { firma: 0, encuesta: 0, examen: 0, taller: 0, proyecto: 0 }, courseIds: new Set() };
      byUser.set(it.userId, e);
    }
    e.counts[it.kind]++;
    e.courseIds.add(it.courseId);
  }
  const rows: StudentPendingRow[] = [];
  for (const [userId, e] of byUser) {
    const total =
      e.counts.firma + e.counts.encuesta + e.counts.examen + e.counts.taller + e.counts.proyecto;
    if (total === 0) continue;
    rows.push({
      userId,
      name: names.get(userId) ?? "—",
      courses: [...e.courseIds]
        .map((id) => courseNames.get(id))
        .filter((n): n is string => !!n)
        .sort((a, b) => a.localeCompare(b, "es-CO", { sensitivity: "base" })),
      firma: e.counts.firma,
      encuesta: e.counts.encuesta,
      examen: e.counts.examen,
      taller: e.counts.taller,
      proyecto: e.counts.proyecto,
      total,
    });
  }
  // Mayor cantidad de pendientes primero (lo accionable arriba); desempate por
  // nombre para un orden estable.
  return rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "es-CO"));
}

/** ¿La encuesta está abierta AHORA? Publicada, dentro de su ventana y no
 *  cerrada a mano — mismo criterio que `/app/student/polls`. */
export function pollIsOpen(
  p: { opens_at: string | null; closes_at: string | null; closed_manually: boolean | null },
  now: number,
): boolean {
  if (p.closed_manually) return false;
  if (p.opens_at && new Date(p.opens_at).getTime() > now) return false;
  if (p.closes_at && new Date(p.closes_at).getTime() <= now) return false;
  return true;
}

/**
 * Carga los pendientes por estudiante para un conjunto de cursos.
 *
 * `courseMeta` trae los nombres de los cursos (la pantalla ya los tiene en
 * memoria, así que no se re-consultan). Las submissions de grupo se cuentan por
 * `user_id` (último editor) — un miembro de grupo que no editó puede figurar
 * como pendiente aunque el grupo haya entregado; es la misma aproximación que
 * `computeNoPresentedStudents` y se acepta en v1.
 */
export async function loadPendingStudents(
  courseMeta: ReadonlyArray<{ id: string; name: string }>,
): Promise<StudentPendingRow[]> {
  const courseIds = courseMeta.map((c) => c.id);
  if (courseIds.length === 0) return [];
  const courseNames = new Map(courseMeta.map((c) => [c.id, c.name]));

  // Matrículas: curso → estudiantes, y el universo de user_ids.
  const { data: enrollRaw } = await dbAny
    .from("course_enrollments")
    .select("course_id, user_id")
    .in("course_id", courseIds);
  const enrollments = (enrollRaw ?? []) as Array<{ course_id: string; user_id: string }>;
  const studentsByCourse = new Map<string, Set<string>>();
  for (const e of enrollments) {
    let s = studentsByCourse.get(e.course_id);
    if (!s) studentsByCourse.set(e.course_id, (s = new Set()));
    s.add(e.user_id);
  }

  const items: PendingItem[] = [];

  // ── Exámenes sin presentar ──────────────────────────────────────────
  const { data: examRaw } = await dbAny
    .from("exams")
    .select("id, course_id")
    .in("course_id", courseIds)
    .neq("status", "draft")
    .is("deleted_at", null);
  const exams = (examRaw ?? []) as Array<{ id: string; course_id: string }>;
  const examIds = exams.map((e) => e.id);
  const examPresented = new Set<string>(); // `${exam_id}::${user_id}`
  if (examIds.length > 0) {
    const { data: subRaw } = await dbAny
      .from("submissions")
      .select("exam_id, user_id")
      .in("exam_id", examIds);
    for (const s of (subRaw ?? []) as Array<{ exam_id: string; user_id: string }>) {
      examPresented.add(`${s.exam_id}::${s.user_id}`);
    }
  }
  for (const ex of exams) {
    const students = studentsByCourse.get(ex.course_id);
    if (!students) continue;
    for (const uid of students) {
      if (!examPresented.has(`${ex.id}::${uid}`)) {
        items.push({ userId: uid, courseId: ex.course_id, kind: "examen" });
      }
    }
  }

  // ── Talleres sin entregar (M:N vía workshop_courses) ────────────────
  await collectActivityPending({
    joinTable: "workshop_courses",
    embed: "workshop:workshops(id, status, deleted_at)",
    subTable: "workshop_submissions",
    subFk: "workshop_id",
    kind: "taller",
    courseIds,
    studentsByCourse,
    items,
  });

  // ── Proyectos sin entregar (M:N vía project_courses) ────────────────
  await collectActivityPending({
    joinTable: "project_courses",
    embed: "project:projects(id, status, deleted_at)",
    subTable: "project_submissions",
    subFk: "project_id",
    kind: "proyecto",
    courseIds,
    studentsByCourse,
    items,
  });

  // ── Encuestas abiertas sin responder ────────────────────────────────
  const { data: pcRaw } = await dbAny
    .from("poll_courses")
    .select("poll_id, course_id")
    .in("course_id", courseIds);
  const pollCourses = (pcRaw ?? []) as Array<{ poll_id: string; course_id: string }>;
  const pollIds = Array.from(new Set(pollCourses.map((r) => r.poll_id)));
  if (pollIds.length > 0) {
    const { data: pollRaw } = await dbAny
      .from("polls")
      .select("id, poll_type, opens_at, closes_at, closed_manually")
      .in("id", pollIds)
      .is("deleted_at", null)
      .neq("poll_type", "kahoot");
    const now = Date.now();
    const openPolls = ((pollRaw ?? []) as Array<{
      id: string;
      opens_at: string | null;
      closes_at: string | null;
      closed_manually: boolean | null;
    }>).filter((p) => pollIsOpen(p, now));
    const openPollIds = new Set(openPolls.map((p) => p.id));
    if (openPollIds.size > 0) {
      const openIdList = [...openPollIds];
      const [{ data: votes }, { data: mixed }] = await Promise.all([
        dbAny.from("poll_responses").select("poll_id, user_id").in("poll_id", openIdList),
        dbAny.from("poll_question_responses").select("poll_id, user_id").in("poll_id", openIdList),
      ]);
      const answered = new Set<string>(); // `${poll_id}::${user_id}`
      for (const r of (votes ?? []) as Array<{ poll_id: string; user_id: string }>)
        answered.add(`${r.poll_id}::${r.user_id}`);
      for (const r of (mixed ?? []) as Array<{ poll_id: string; user_id: string }>)
        answered.add(`${r.poll_id}::${r.user_id}`);
      // Curso de referencia por (poll, estudiante): el primero de los cursos de
      // la encuesta donde el estudiante está matriculado.
      for (const pc of pollCourses) {
        if (!openPollIds.has(pc.poll_id)) continue;
        const students = studentsByCourse.get(pc.course_id);
        if (!students) continue;
        for (const uid of students) {
          const seen = `${pc.poll_id}::${uid}`;
          if (answered.has(seen)) continue;
          // Marcar como respondido-para-no-duplicar: una encuesta cuenta una vez
          // por estudiante aunque esté compartida en varios de sus cursos.
          answered.add(seen);
          items.push({ userId: uid, courseId: pc.course_id, kind: "encuesta" });
        }
      }
    }
  }

  // ── Firmas pendientes ───────────────────────────────────────────────
  // report_signatures → generated_reports.course_id. La RLS ya limita a los
  // informes de MIS cursos; el `.in` sobre el embed acota al scope actual.
  const { data: sigRaw } = await dbAny
    .from("report_signatures")
    .select("user_id, generated_reports!inner(course_id)")
    .is("signed_at", null)
    .in("generated_reports.course_id", courseIds);
  for (const s of (sigRaw ?? []) as Array<{
    user_id: string;
    generated_reports: { course_id: string } | null;
  }>) {
    const courseId = s.generated_reports?.course_id;
    if (!courseId) continue;
    items.push({ userId: s.user_id, courseId, kind: "firma" });
  }

  // ── Nombres (user_id → auth.users, NO embebible a profiles) ─────────
  const userIds = Array.from(new Set(items.map((it) => it.userId)));
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profRaw } = await dbAny
      .from("profiles")
      .select("id, full_name")
      .in("id", userIds);
    for (const p of (profRaw ?? []) as Array<{ id: string; full_name: string | null }>) {
      names.set(p.id, p.full_name ?? "—");
    }
  }

  return aggregatePending(items, names, courseNames);
}

/** Recolecta pendientes de una actividad M:N (taller/proyecto). Compartido
 *  entre talleres y proyectos porque el shape es idéntico. */
async function collectActivityPending(opts: {
  joinTable: string;
  embed: string;
  subTable: string;
  subFk: string;
  kind: PendingKind;
  courseIds: string[];
  studentsByCourse: Map<string, Set<string>>;
  items: PendingItem[];
}): Promise<void> {
  const { data: joinRaw } = await dbAny
    .from(opts.joinTable)
    .select(`course_id, ${opts.embed}`)
    .in("course_id", opts.courseIds);
  const key = opts.embed.split(":")[0]; // "workshop" / "project"
  // (courseId, activityId) que cuentan: no borrador, no papelera.
  const activities: Array<{ id: string; courseId: string }> = [];
  for (const r of (joinRaw ?? []) as Array<Record<string, unknown>>) {
    const item = r[key] as { id?: string; status?: string; deleted_at?: string | null } | null;
    if (!item?.id) continue;
    if (item.deleted_at) continue;
    if (item.status === "draft") continue;
    activities.push({ id: item.id, courseId: String(r.course_id) });
  }
  const activityIds = Array.from(new Set(activities.map((a) => a.id)));
  const submitted = new Set<string>(); // `${activity_id}::${user_id}`
  if (activityIds.length > 0) {
    const { data: subRaw } = await dbAny
      .from(opts.subTable)
      .select(`${opts.subFk}, user_id`)
      .in(opts.subFk, activityIds);
    for (const s of (subRaw ?? []) as Array<Record<string, unknown>>) {
      submitted.add(`${String(s[opts.subFk])}::${String(s.user_id)}`);
    }
  }
  for (const a of activities) {
    const students = opts.studentsByCourse.get(a.courseId);
    if (!students) continue;
    for (const uid of students) {
      if (!submitted.has(`${a.id}::${uid}`)) {
        opts.items.push({ userId: uid, courseId: a.courseId, kind: opts.kind });
      }
    }
  }
}
