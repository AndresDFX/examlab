/**
 * Builder del TemplateContext para los informes.
 *
 * `buildReportContext({ courseId, studentId? })`:
 *   - Si pasas `studentId` → scope 'estudiante': contexto del alumno único
 *     con `{{estudiante.*}}`, `{{nota_final}}`, `{{cortes}}`, `{{asistencia}}`.
 *   - Si NO pasas `studentId` → scope 'curso': contexto consolidado con
 *     `{{estudiantes}}` (array; cada item tiene su nota_final, asistencia,
 *     etc) además de `{{curso}}`, `{{docente}}`, `{{periodo}}`.
 *
 * Todos los datos se leen vía supabase (RLS aplica). Las notas se calculan
 * con los mismos helpers que usa el gradebook (`computeWeightedGrade`),
 * así que el boletín y la pantalla del gradebook nunca divergen.
 *
 * Para imprimir un ACTA OFICIAL con datos INMUTABLES, usa
 * `buildReportContextFromActa(actaId)` — lee el snapshot congelado de
 * `course_actas` (notas, cohorte, cortes calculados al cierre).
 */
import { supabase } from "@/integrations/supabase/client";
import {
  computeWeightedGrade,
  countsAsPresent,
  scaleAttendance,
  type GradedItem,
} from "@/modules/grading/grade";
import {
  computeAttemptGrade,
  type AttemptForGrade,
  type RetryMode,
} from "@/modules/exams/exam-attempts";
import { formatDate } from "@/shared/lib/format";
import {
  formatScheduleText,
  type CourseScheduleBlock,
} from "@/modules/schedules/course-schedule";
import type { TemplateContext } from "./template-engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface BuildReportArgs {
  courseId: string;
  /** Si presente → scope 'estudiante'. Si ausente → scope 'curso'. */
  studentId?: string;
  /** Texto a usar como periodo (ej. "2026-1"). Opcional. */
  periodo?: string;
}

// ── Tipos internos (lo que devolvemos al motor) ─────────────────────

interface CutCtx {
  nombre: string;
  peso: number;
  nota: number | null;
}

interface ItemCtx {
  titulo: string;
  nota: number | null;
  peso: number;
  tipo: "examen" | "taller" | "proyecto";
}

interface AsistenciaCtx {
  presentes: number;
  ausentes: number;
  total: number;
  porcentaje: number;
}

interface StudentCtx {
  id: string;
  nombre: string;
  email: string;
  /** Código estudiantil institucional (matrícula). Vacío si no se
   *  configuró en el perfil — los reportes lo muestran como "—". */
  codigo: string;
  /** Documento de identidad (cédula/pasaporte). */
  documento: string;
  /** Cohorte de ingreso. */
  cohorte: string;
  /** Estado académico: activo / retirado / graduado / aplazado. */
  estado: string;
  /** Programa académico al que pertenece el estudiante. */
  programa: string;
  nota_final: number | null;
  /** Computed: nota_final != null && >= passing_grade. Útil para
   *  {{#if aprobado}} en actas y certificados. */
  aprobado: boolean;
  /** Computed: "Aprobado" | "Reprobado" | "Sin nota". Para mostrar
   *  como texto en plantillas sin necesidad de lógica. */
  estado_aprobacion: string;
  cortes: CutCtx[];
  examenes: ItemCtx[];
  talleres: ItemCtx[];
  proyectos: ItemCtx[];
  asistencia: AsistenciaCtx;
}

// ── Helpers ─────────────────────────────────────────────────────────

function attendanceFor(
  userId: string,
  sessionIds: string[],
  records: Array<{ session_id: string; user_id: string; status: string }>,
): AsistenciaCtx {
  const total = sessionIds.length;
  if (total === 0) return { presentes: 0, ausentes: 0, total: 0, porcentaje: 0 };
  const mine = records.filter((r) => r.user_id === userId && sessionIds.includes(r.session_id));
  const presentes = mine.filter((r) => countsAsPresent(r.status)).length;
  const ausentes = total - presentes;
  const porcentaje = Math.round((presentes / total) * 100);
  return { presentes, ausentes, total, porcentaje };
}

/** Score efectivo de un item (override del docente gana sobre IA). */
function effectiveScore(sub: {
  ai_grade?: number | null;
  final_grade?: number | null;
  final_override_grade?: number | null;
} | null): number | null {
  if (!sub) return null;
  // submissions usa final_override_grade, workshop/project usan final_grade
  const explicit = sub.final_override_grade ?? sub.final_grade;
  if (explicit != null) return Number(explicit);
  if (sub.ai_grade != null) return Number(sub.ai_grade);
  return null;
}

// ── Builder principal ───────────────────────────────────────────────

export async function buildReportContext(args: BuildReportArgs): Promise<TemplateContext> {
  const { courseId, studentId, periodo } = args;

  // ── Curso (con join al programa académico + periodo si tiene FKs) ──
  const { data: courseRow } = await db
    .from("courses")
    .select(
      "id, name, code, semestre, grupo, period, period_id, grade_scale_min, grade_scale_max, passing_grade, program_id, subject_id, program:academic_programs(name, code, faculty), periodo_obj:academic_periods!courses_period_id_fkey(code, name, start_date, end_date, status), subject:academic_subjects(name, code, semestre, credits)",
    )
    .eq("id", courseId)
    .maybeSingle();
  if (!courseRow) {
    throw new Error("Curso no encontrado o sin permisos");
  }

  // ── Docente del curso (el primero asignado) ─────────────────────
  const { data: tcRow } = await db
    .from("course_teachers")
    .select("user_id")
    .eq("course_id", courseId)
    .limit(1)
    .maybeSingle();
  let docente = { nombre: "—", email: "—" };
  if (tcRow?.user_id) {
    const { data: docProf } = await db
      .from("profiles")
      .select("full_name, institutional_email")
      .eq("id", tcRow.user_id)
      .maybeSingle();
    if (docProf) {
      docente = {
        nombre: docProf.full_name ?? "—",
        email: docProf.institutional_email ?? "—",
      };
    }
  }

  // ── Institución (settings globales) ─────────────────────────────
  const { data: certSettings } = await db
    .from("certificate_settings")
    .select("institution_name, institution_logo_url")
    .maybeSingle();

  // Horario del curso (bloques semanales). Lo formateamos a texto
  // plano para que la plantilla lo use como un campo simple.
  const { data: scheduleRows } = await db
    .from("course_schedules")
    .select("day_of_week, start_time, end_time, aula, modalidad")
    .eq("course_id", courseId);
  const scheduleText = formatScheduleText(
    ((scheduleRows ?? []) as CourseScheduleBlock[]).map((b) => ({
      day_of_week: b.day_of_week,
      start_time: b.start_time,
      end_time: b.end_time,
      aula: b.aula ?? null,
      modalidad: b.modalidad,
      notes: null,
    })),
  );
  const institucion = {
    nombre: certSettings?.institution_name ?? "—",
    logo: certSettings?.institution_logo_url ?? "",
  };

  // ── Cortes + items + asistencia (mismas queries del gradebook) ──
  const [{ data: cuts }, { data: examsAll }, { data: workshopsAll }, { data: pcRows }, { data: sessions }] =
    await Promise.all([
      db
        .from("grade_cuts")
        .select("id, name, position, weight, attendance_weight")
        .eq("course_id", courseId)
        .order("position"),
      db
        .from("exams")
        .select("id, title, cut_id, weight, parent_exam_id, retry_mode, status")
        .eq("course_id", courseId)
        .is("deleted_at", null),
      db
        .from("workshops")
        .select("id, title, cut_id, weight, max_score, is_external, status")
        .eq("course_id", courseId)
        .is("deleted_at", null),
      db
        .from("project_courses")
        .select("cut_id, weight, project:projects(id, title, max_score, is_external, deleted_at, status)")
        .eq("course_id", courseId),
      db
        .from("attendance_sessions")
        .select("id, cut_id, session_date")
        .eq("course_id", courseId)
        .is("deleted_at", null),
    ]);

  // Excluir BORRADORES (status='draft') de TODO el cálculo — paridad con el
  // gradebook docente y la vista del estudiante, que usan `(status ??
  // 'published') !== 'draft'`. Un item en borrador (default status) con peso +
  // corte pero SIN entregas → score null → contaría como 0 y BAJARÍA la nota
  // del boletín/acta respecto de lo que el docente y el alumno ven en pantalla.
  // Tratamos status NULL como 'published' (legacy) → NO se excluye.
  const isDraft = (s?: string | null) => (s ?? "published") === "draft";
  const exams = ((examsAll ?? []) as Array<{
    id: string;
    title: string;
    cut_id: string | null;
    weight: number;
    parent_exam_id: string | null;
    retry_mode: string | null;
    status: string | null;
  }>).filter((e) => !isDraft(e.status));
  const workshops = ((workshopsAll ?? []) as Array<{
    id: string;
    title: string;
    cut_id: string | null;
    weight: number;
    max_score: number;
    is_external: boolean | null;
    status: string | null;
  }>).filter((w) => !isDraft(w.status));

  const projects = ((pcRows ?? []) as Array<{ cut_id: string | null; weight: number; project: { id: string; title: string; max_score: number; is_external: boolean | null; deleted_at: string | null; status: string | null } | null }>)
    .filter((r): r is { cut_id: string | null; weight: number; project: { id: string; title: string; max_score: number; is_external: boolean | null; deleted_at: string | null; status: string | null } } => r.project != null && !r.project.deleted_at && !isDraft(r.project.status))
    .map((r) => ({ id: r.project.id, title: r.project.title, cut_id: r.cut_id, weight: r.weight, max_score: r.project.max_score, is_external: r.project.is_external }));

  // Filtrar exámenes sin parent (los make-up children se agregan al original)
  const examOriginals = exams.filter((e) => !e.parent_exam_id);

  // ── Estudiantes (uno o todos) ────────────────────────────────────
  let userIds: string[];
  if (studentId) {
    userIds = [studentId];
  } else {
    const { data: enr } = await db
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    userIds = ((enr ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  }
  if (userIds.length === 0) {
    throw new Error("No hay estudiantes para el informe");
  }

  const { data: profs } = await db
    .from("profiles")
    .select(
      "id, full_name, institutional_email, codigo, documento, cohorte, estado, programa_id, programa:academic_programs!profiles_programa_id_fkey(name)",
    )
    .in("id", userIds)
    .order("full_name");

  // ── Entregas (bulk) ──────────────────────────────────────────────
  const examIds = (exams ?? []).map((e: { id: string }) => e.id);
  const wsIds = (workshops ?? []).map((w: { id: string }) => w.id);
  const prjIds = projects.map((p) => p.id);
  const sessIds = ((sessions ?? []) as Array<{ id: string }>).map((s) => s.id);

  const [{ data: examSubs }, { data: wsSubs }, { data: prjSubs }, { data: attRecs }] =
    await Promise.all([
      examIds.length
        ? db
            .from("submissions")
            .select("exam_id, user_id, ai_grade, final_override_grade, status, created_at")
            .in("exam_id", examIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      // NO filtramos por user_id: una entrega GRUPAL tiene user_id = solo el
      // "último editor". Traemos todas las entregas de los talleres/proyectos del
      // curso (RLS scopea al docente/admin del curso) + group_id, y resolvemos por
      // MEMBRESÍA de grupo abajo — espejo del gradebook (fuente del certificado) y
      // de app.student.grades. Antes, con .in("user_id", userIds), los miembros
      // del grupo distintos del editor obtenían score null → 0 en su boletín/acta.
      wsIds.length
        ? db
            .from("workshop_submissions")
            .select("workshop_id, user_id, group_id, ai_grade, final_grade, status")
            .in("workshop_id", wsIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      prjIds.length
        ? db
            .from("project_submissions")
            .select("project_id, user_id, group_id, ai_grade, final_grade, status")
            .in("project_id", prjIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      sessIds.length
        ? db
            .from("attendance_records")
            .select("session_id, user_id, status")
            .in("session_id", sessIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

  // ── Membresía de grupos (taller/proyecto): userId → set(group_id) ──
  // Espejo del gradebook: los miembros del grupo distintos del editor se
  // resuelven por su pertenencia al group_id de la submission grupal.
  const buildGroupMap = async (
    itemIds: string[],
    groupsTable: string,
    membersTable: string,
    fkCol: string,
  ): Promise<Map<string, Set<string>>> => {
    const map = new Map<string, Set<string>>();
    if (!itemIds.length) return map;
    const { data: groups } = await db.from(groupsTable).select("id").in(fkCol, itemIds);
    const gIds = ((groups ?? []) as Array<{ id: string }>).map((g) => g.id);
    if (!gIds.length) return map;
    const { data: members } = await db
      .from(membersTable)
      .select("group_id, user_id")
      .in("group_id", gIds);
    for (const m of (members ?? []) as Array<{ group_id: string; user_id: string }>) {
      if (!map.has(m.user_id)) map.set(m.user_id, new Set());
      map.get(m.user_id)!.add(m.group_id);
    }
    return map;
  };
  const [wsGroupsByUser, prjGroupsByUser] = await Promise.all([
    buildGroupMap(wsIds, "workshop_groups", "workshop_group_members", "workshop_id"),
    buildGroupMap(prjIds, "project_groups", "project_group_members", "project_id"),
  ]);

  // ── Construir StudentCtx por usuario ─────────────────────────────
  const escalaMax = Number(courseRow.grade_scale_max ?? 5);
  const escalaMin = Number((courseRow as { grade_scale_min?: number }).grade_scale_min ?? 0);
  // Escala una nota cruda (0..rawMax) al rango [min,max] del curso — MISMA
  // fórmula que el gradebook (app.teacher.gradebook.tsx toScale) y la vista del
  // estudiante. Sin esto, una nota de taller 80/100 entraba CRUDA (80) al
  // promedio ponderado junto a exámenes 0..5 → nota final del acta/boletín
  // groseramente inflada y distinta del certificado.
  const toScale = (raw: number, rawMax: number): number => {
    const pct = rawMax > 0 ? raw / rawMax : 0;
    return escalaMin + pct * (escalaMax - escalaMin);
  };
  // Nota mínima para aprobar (usada en plantilla de Acta para marcar
  // 'Aprobado' / 'Reprobado'). Default 3 — coincide con el default del
  // form de cursos en app.admin.courses.tsx.
  const passingGrade = Number(courseRow.passing_grade ?? 3);

  // Nota efectiva de un examen para un alumno, RESPETANDO retry_mode
  // (last/average/highest) sobre TODOS sus intentos + fallback a las
  // recuperaciones (parent_exam_id) cuando no hay intentos directos. Es el
  // MISMO algoritmo del gradebook (getGrade + consolidado) y del acta SQL.
  // Antes el boletín tomaba un intento arbitrario con `.find()` ignorando
  // retry_mode → la nota impresa podía basarse en el intento equivocado
  // (ej. un examen "highest" con un reintento mejor mostraba el peor).
  const allExamSubs = (examSubs ?? []) as Array<{
    exam_id: string;
    user_id: string;
    ai_grade: number | null;
    final_override_grade: number | null;
    status: string | null;
    created_at: string;
  }>;
  const resolveExamGrade = (
    examId: string,
    retryMode: RetryMode,
    userId: string,
  ): number | null => {
    // computeAttemptGrade devuelve la nota cruda en 0..grade_scale_max; el
    // gradebook/estudiante la re-escalan a [min,max] con toScale(raw, max). Sin
    // este toScale, en cursos con min>0 el examen del acta/boletín usaba la nota
    // cruda (0-based) mientras la pantalla mostraba la escalada → divergencia.
    const own = allExamSubs.filter((s) => s.exam_id === examId && s.user_id === userId);
    if (own.length) {
      const raw = computeAttemptGrade(own as AttemptForGrade[], retryMode);
      return raw == null ? null : toScale(raw, escalaMax);
    }
    // Sin intentos directos → recuperaciones, cada una con su propio retry_mode.
    for (const m of exams.filter((mk) => mk.parent_exam_id === examId)) {
      const subs = allExamSubs.filter((s) => s.exam_id === m.id && s.user_id === userId);
      if (subs.length) {
        const raw = computeAttemptGrade(subs as AttemptForGrade[], (m.retry_mode as RetryMode) ?? "last");
        return raw == null ? null : toScale(raw, escalaMax);
      }
    }
    return null;
  };

  // Nota efectiva de un taller/proyecto para un alumno, resolviendo por
  // MEMBRESÍA de grupo y ESCALANDO por max_score (o escala del curso si es
  // externo) — espejo exacto del gradebook (fuente del certificado).
  const wsSubsAll = (wsSubs ?? []) as Array<{
    workshop_id: string;
    user_id: string;
    group_id: string | null;
    ai_grade: number | null;
    final_grade: number | null;
    status: string | null;
  }>;
  const prjSubsAll = (prjSubs ?? []) as Array<{
    project_id: string;
    user_id: string;
    group_id: string | null;
    ai_grade: number | null;
    final_grade: number | null;
    status: string | null;
  }>;
  const resolveWorkshopGrade = (
    w: { id: string; max_score: number; is_external: boolean | null },
    userId: string,
  ): number | null => {
    const sub = wsSubsAll.find(
      (s) =>
        s.workshop_id === w.id &&
        (s.user_id === userId || (!!s.group_id && !!wsGroupsByUser.get(userId)?.has(s.group_id))),
    );
    const raw = effectiveScore(sub ?? null);
    if (raw == null) return null;
    return toScale(raw, w.is_external ? escalaMax : (w.max_score ?? 100));
  };
  const resolveProjectGrade = (
    p2: { id: string; max_score: number; is_external: boolean | null },
    userId: string,
  ): number | null => {
    const sub = prjSubsAll.find(
      (s) =>
        s.project_id === p2.id &&
        (s.user_id === userId || (!!s.group_id && !!prjGroupsByUser.get(userId)?.has(s.group_id))),
    );
    const raw = effectiveScore(sub ?? null);
    if (raw == null) return null;
    return toScale(raw, p2.is_external ? escalaMax : (p2.max_score ?? 100));
  };

  const buildStudent = (p: {
    id: string;
    full_name: string;
    institutional_email: string;
    codigo?: string | null;
    documento?: string | null;
    cohorte?: string | null;
    estado?: string | null;
    programa?: { name: string } | null;
  }): StudentCtx => {
    const userId = p.id;

    // Items por tipo (con su nota efectiva)
    const examenes: ItemCtx[] = examOriginals.map((e) => ({
      titulo: e.title,
      nota: resolveExamGrade(e.id, (e.retry_mode as RetryMode) ?? "last", userId),
      peso: Number(e.weight ?? 0),
      tipo: "examen" as const,
    }));
    const talleres: ItemCtx[] = (workshops ?? []).map((w) => ({
      titulo: w.title,
      nota: resolveWorkshopGrade(w, userId),
      peso: Number(w.weight ?? 0),
      tipo: "taller" as const,
    }));
    const proyectos: ItemCtx[] = projects.map((p2) => ({
      titulo: p2.title,
      nota: resolveProjectGrade(p2, userId),
      peso: Number(p2.weight ?? 0),
      tipo: "proyecto" as const,
    }));

    // Asistencia general
    const asistencia = attendanceFor(userId, sessIds, (attRecs ?? []) as Array<{ session_id: string; user_id: string; status: string }>);

    // Cortes: nota del corte = ponderado de items + asistencia DEL corte
    // Acumula TODOS los items (de todos los cortes + asistencias) para la nota
    // final PLANA — mismo algoritmo que el gradebook/estudiante (evita el doble
    // redondeo/re-escala del promedio-de-cortes). G1/G5.
    const allFinalItems: GradedItem[] = [];
    const cortes: CutCtx[] = ((cuts ?? []) as Array<{ id: string; name: string; weight: number; attendance_weight: number }>).map((cut) => {
      // Solo exámenes ORIGINALES por corte (los make-up children se colapsan en
      // el original vía resolveExamGrade) — evita doble conteo si un child tiene
      // cut_id + weight propios.
      const cutExams = examOriginals.filter((e) => e.cut_id === cut.id);
      const cutWs = workshops.filter((w) => w.cut_id === cut.id);
      const cutPrjs = projects.filter((p2) => p2.cut_id === cut.id);
      const cutSessIds = ((sessions ?? []) as Array<{ id: string; cut_id: string | null }>)
        .filter((s) => s.cut_id === cut.id)
        .map((s) => s.id);

      const items: GradedItem[] = [];
      for (const e of cutExams) {
        items.push({
          weight: Number(e.weight ?? 0),
          score: resolveExamGrade(e.id, (e.retry_mode as RetryMode) ?? "last", userId),
        });
      }
      for (const w of cutWs) {
        items.push({ weight: Number(w.weight ?? 0), score: resolveWorkshopGrade(w, userId) });
      }
      for (const p2 of cutPrjs) {
        items.push({ weight: Number(p2.weight ?? 0), score: resolveProjectGrade(p2, userId) });
      }
      // Asistencia del corte — escala al rango [min,max] del curso (G2; antes
      // usaba pct*max e ignoraba grade_scale_min). Usa la fracción EXACTA
      // presentes/total (no el porcentaje redondeado a entero) para no divergir
      // del gradebook en casos borde.
      if (cutSessIds.length > 0 && cut.attendance_weight > 0) {
        const cutAtt = attendanceFor(userId, cutSessIds, (attRecs ?? []) as Array<{ session_id: string; user_id: string; status: string }>);
        const attScore = scaleAttendance(
          cutAtt.total > 0 ? cutAtt.presentes / cutAtt.total : 0,
          escalaMin,
          escalaMax,
        );
        items.push({ weight: Number(cut.attendance_weight ?? 0), score: attScore });
      }
      allFinalItems.push(...items);
      const nota = computeWeightedGrade(items);
      return { nombre: cut.name, peso: Number(cut.weight ?? 0), nota };
    });

    // Items SIN corte asignado (cut_id null): el gradebook y la vista del
    // estudiante los INCLUYEN en la nota final (y el certificado se emite con
    // ese número). El acta/boletín los ignoraban → nota final divergente del
    // certificado. Los sumamos al weighted avg plano con su peso.
    for (const e of examOriginals.filter((e) => !e.cut_id)) {
      allFinalItems.push({
        weight: Number(e.weight ?? 0),
        score: resolveExamGrade(e.id, (e.retry_mode as RetryMode) ?? "last", userId),
      });
    }
    for (const w of workshops.filter((w) => !w.cut_id)) {
      allFinalItems.push({ weight: Number(w.weight ?? 0), score: resolveWorkshopGrade(w, userId) });
    }
    for (const p2 of projects.filter((p2) => !p2.cut_id)) {
      allFinalItems.push({ weight: Number(p2.weight ?? 0), score: resolveProjectGrade(p2, userId) });
    }

    // Nota final del curso = promedio ponderado PLANO de TODOS los items +
    // asistencias (NO promedio de las notas de corte). Igual que el gradebook
    // y la vista del estudiante (G1/G5).
    const notaFinal = computeWeightedGrade(allFinalItems);

    // Calcular estado de aprobación. notaFinal null = "Sin nota".
    const aprobado = notaFinal != null && notaFinal >= passingGrade;
    const estadoAprobacion =
      notaFinal == null ? "Sin nota" : aprobado ? "Aprobado" : "Reprobado";
    return {
      id: userId,
      nombre: p.full_name ?? "—",
      email: p.institutional_email ?? "—",
      codigo: p.codigo ?? "",
      documento: p.documento ?? "",
      cohorte: p.cohorte ?? "",
      estado: p.estado ?? "",
      programa: p.programa?.name ?? "",
      nota_final: notaFinal,
      aprobado,
      estado_aprobacion: estadoAprobacion,
      cortes,
      examenes,
      talleres,
      proyectos,
      asistencia,
    };
  };

  const studentList: StudentCtx[] = (profs ?? []).map(buildStudent);

  // ── Contexto base común ─────────────────────────────────────────
  const baseCtx: TemplateContext = {
    curso: {
      nombre: courseRow.name,
      codigo: courseRow.code ?? "",
      semestre: courseRow.semestre ?? "",
      grupo: courseRow.grupo ?? "",
      // Programa académico — `program` viene del embed PostgREST.
      // Si el curso no tiene program_id, queda como string vacío para
      // que el render no muestre "undefined" en el PDF.
      programa: courseRow.program?.name ?? "",
      programa_codigo: courseRow.program?.code ?? "",
      facultad: courseRow.program?.faculty ?? "",
      // Asignatura del plan (FK subject_id). Si está asociado, exponemos
      // el nombre + código + créditos para el header de informes
      // (útil cuando el plan curricular dicta nombres específicos).
      asignatura: courseRow.subject?.name ?? "",
      asignatura_codigo: courseRow.subject?.code ?? "",
      creditos: courseRow.subject?.credits ?? "",
      // Horario semanal formateado: "Lun 10:00–12:00 (Aula 301) · Jue 14:00–16:00 (virtual)".
      // Vacío si el curso no tiene bloques definidos todavía.
      horario: scheduleText,
    },
    docente,
    institucion,
    escala_max: escalaMax,
    // Prioridad para {{periodo}}:
    //   1. periodo del caller (lo que escriba el docente en el dialog)
    //   2. code del periodo asociado vía FK
    //   3. campo texto legacy `period`
    periodo: periodo ?? courseRow.periodo_obj?.code ?? courseRow.period ?? "",
    // Estructura completa del periodo (cuando hay FK). Útil para
    // plantillas avanzadas que quieran fechas o estado.
    periodo_obj: courseRow.periodo_obj ?? null,
    fecha_emision: formatDate(new Date()),
  };

  if (studentId) {
    // Scope 'estudiante': aplanamos las propiedades del único alumno al root
    const s = studentList[0];
    if (!s) throw new Error("Estudiante no encontrado");
    return {
      ...baseCtx,
      estudiante: {
        nombre: s.nombre,
        email: s.email,
        codigo: s.codigo,
        documento: s.documento,
        cohorte: s.cohorte,
        estado: s.estado,
        programa: s.programa,
      },
      nota_final: s.nota_final,
      // aprobado / estado_aprobacion: se calculan por alumno en buildStudent y el
      // catálogo de variables los anuncia, pero el scope 'estudiante' los omitía →
      // {{estado_aprobacion}} y {{#if aprobado}} salían vacíos en constancias/actas.
      aprobado: s.aprobado,
      estado_aprobacion: s.estado_aprobacion,
      cortes: s.cortes,
      examenes: s.examenes,
      talleres: s.talleres,
      proyectos: s.proyectos,
      asistencia: s.asistencia,
    };
  }

  // Scope 'curso': exponemos `estudiantes` como array iterable
  return {
    ...baseCtx,
    estudiantes: studentList.map((s) => ({
      nombre: s.nombre,
      email: s.email,
      codigo: s.codigo,
      documento: s.documento,
      cohorte: s.cohorte,
      estado: s.estado,
      programa: s.programa,
      nota_final: s.nota_final,
      aprobado: s.aprobado,
      estado_aprobacion: s.estado_aprobacion,
      asistencia: s.asistencia,
      cortes: s.cortes,
      examenes: s.examenes,
      talleres: s.talleres,
      proyectos: s.proyectos,
    })),
    // Estadísticas agregadas del curso (para encabezados de actas).
    total_estudiantes: studentList.length,
    total_aprobados: studentList.filter((s) => s.aprobado).length,
    total_reprobados: studentList.filter(
      (s) => s.nota_final != null && !s.aprobado,
    ).length,
    total_sin_nota: studentList.filter((s) => s.nota_final == null).length,
  };
}

/**
 * Construye el TemplateContext desde el SNAPSHOT INMUTABLE de un acta
 * oficial (`course_actas.snapshot`). Las notas, cohorte y datos del
 * curso vienen congelados al momento del cierre — modificar el
 * gradebook después NO afecta lo que se imprime.
 *
 * La institución (logo + nombre) sí se lee viva, porque es branding
 * y debe reflejar la realidad actual de la institución, no la del
 * momento del cierre.
 */
export async function buildReportContextFromActa(actaId: string): Promise<TemplateContext> {
  const { data: actaRow, error } = await db
    .from("course_actas")
    .select("snapshot, generated_at, integrity_hash, periodo_codigo")
    .eq("id", actaId)
    .maybeSingle();
  if (error || !actaRow) {
    throw new Error("Acta no encontrada o sin permisos");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap = actaRow.snapshot as any;

  // Institución se lee viva (branding actual, no histórico).
  const { data: certSettings } = await db
    .from("certificate_settings")
    .select("institution_name, institution_logo_url")
    .maybeSingle();
  const institucion = {
    nombre: certSettings?.institution_name ?? "—",
    logo: certSettings?.institution_logo_url ?? "",
  };

  const escalaMax = Number(snap?.curso?.escala_max ?? 5);
  const periodoCode = snap?.periodo?.code ?? actaRow.periodo_codigo ?? "";

  // El snapshot guarda estudiantes con nota_final y estado_aprobacion
  // como string ('aprobado'|'reprobado'|'sin_nota'). Re-mapeamos al
  // shape que las plantillas esperan (con booleano 'aprobado').
  const studentList = (Array.isArray(snap?.estudiantes) ? snap.estudiantes : []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => {
      const notaFinal = s.nota_final == null ? null : Number(s.nota_final);
      const estadoApr =
        s.estado_aprobacion === "aprobado"
          ? "Aprobado"
          : s.estado_aprobacion === "reprobado"
            ? "Reprobado"
            : "Sin nota";
      return {
        id: s.id,
        nombre: s.nombre ?? "—",
        email: s.email ?? "",
        codigo: s.codigo ?? "",
        documento: s.documento ?? "",
        cohorte: s.cohorte ?? "",
        estado: s.estado ?? "",
        programa: snap?.programa?.nombre ?? "",
        nota_final: notaFinal,
        aprobado: s.estado_aprobacion === "aprobado",
        estado_aprobacion: estadoApr,
        // El snapshot tiene cortes por estudiante con shape
        // { nombre, peso, nota } — idéntico a CutCtx, lo pasamos tal cual.
        cortes: Array.isArray(s.cortes) ? s.cortes : [],
        // El snapshot NO almacena los items individuales (examenes,
        // talleres, proyectos) ni asistencia detallada — solo el roll-up
        // por corte. Estos quedan como arrays vacíos para que las
        // plantillas no rompan al hacer {{#each}}.
        examenes: [],
        talleres: [],
        proyectos: [],
        asistencia: { presentes: 0, ausentes: 0, total: 0, porcentaje: 0 },
      };
    },
  );

  const baseCtx: TemplateContext = {
    curso: {
      nombre: snap?.curso?.nombre ?? "—",
      codigo: snap?.curso?.codigo ?? "",
      semestre: snap?.curso?.semestre ?? "",
      grupo: snap?.curso?.grupo ?? "",
      programa: snap?.programa?.nombre ?? "",
      programa_codigo: snap?.programa?.codigo ?? "",
      facultad: "",
      asignatura: "",
      asignatura_codigo: "",
      creditos: "",
      horario: "",
    },
    docente: {
      nombre: snap?.docente?.nombre ?? "—",
      email: snap?.docente?.email ?? "",
    },
    institucion,
    escala_max: escalaMax,
    periodo: periodoCode,
    periodo_obj: snap?.periodo ?? null,
    fecha_emision: formatDate(new Date(actaRow.generated_at)),
    // Metadata propia del acta — útil para que la plantilla muestre
    // el hash y la fecha original del cierre (auditoría visible).
    acta: {
      id: actaId,
      generated_at: actaRow.generated_at,
      integrity_hash: actaRow.integrity_hash,
      hash_corto: String(actaRow.integrity_hash).slice(0, 16),
    },
    estudiantes: studentList,
    total_estudiantes: Number(snap?.total_estudiantes ?? studentList.length),
    total_aprobados: Number(snap?.total_aprobados ?? 0),
    total_reprobados: Number(snap?.total_reprobados ?? 0),
    total_sin_nota: Number(snap?.total_sin_nota ?? 0),
  };

  return baseCtx;
}
