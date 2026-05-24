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
 */
import { supabase } from "@/integrations/supabase/client";
import { computeWeightedGrade, type GradedItem } from "@/modules/grading/grade";
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
  const presentes = mine.filter((r) => r.status === "presente" || r.status === "tarde").length;
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
      "id, name, code, semestre, grupo, period, period_id, grade_scale_max, passing_grade, program_id, subject_id, program:academic_programs(name, code, faculty), periodo_obj:academic_periods!courses_period_id_fkey(code, name, start_date, end_date, status), subject:academic_subjects(name, code, semestre, credits)",
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
  const [{ data: cuts }, { data: exams }, { data: workshops }, { data: pcRows }, { data: sessions }] =
    await Promise.all([
      db
        .from("grade_cuts")
        .select("id, name, position, weight, attendance_weight")
        .eq("course_id", courseId)
        .order("position"),
      db
        .from("exams")
        .select("id, title, cut_id, weight, parent_exam_id")
        .eq("course_id", courseId),
      db
        .from("workshops")
        .select("id, title, cut_id, weight, max_score")
        .eq("course_id", courseId),
      db
        .from("project_courses")
        .select("cut_id, weight, project:projects(id, title, max_score)")
        .eq("course_id", courseId),
      db
        .from("attendance_sessions")
        .select("id, cut_id, session_date")
        .eq("course_id", courseId),
    ]);

  const projects = ((pcRows ?? []) as Array<{ cut_id: string | null; weight: number; project: { id: string; title: string; max_score: number } | null }>)
    .filter((r): r is { cut_id: string | null; weight: number; project: { id: string; title: string; max_score: number } } => r.project != null)
    .map((r) => ({ id: r.project.id, title: r.project.title, cut_id: r.cut_id, weight: r.weight }));

  // Filtrar exámenes sin parent (los make-up children se agregan al original)
  const examOriginals = (exams ?? []).filter((e: { parent_exam_id: string | null }) => !e.parent_exam_id);

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
            .select("exam_id, user_id, ai_grade, final_override_grade, status")
            .in("exam_id", examIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      wsIds.length
        ? db
            .from("workshop_submissions")
            .select("workshop_id, user_id, ai_grade, final_grade, status")
            .in("workshop_id", wsIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      prjIds.length
        ? db
            .from("project_submissions")
            .select("project_id, user_id, ai_grade, final_grade, status")
            .in("project_id", prjIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      sessIds.length
        ? db
            .from("attendance_records")
            .select("session_id, user_id, status")
            .in("session_id", sessIds)
            .in("user_id", userIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

  // ── Construir StudentCtx por usuario ─────────────────────────────
  const escalaMax = Number(courseRow.grade_scale_max ?? 5);
  // Nota mínima para aprobar (usada en plantilla de Acta para marcar
  // 'Aprobado' / 'Reprobado'). Default 3 — coincide con el default del
  // form de cursos en app.admin.courses.tsx.
  const passingGrade = Number(courseRow.passing_grade ?? 3);

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
    const examenes: ItemCtx[] = examOriginals.map((e: { id: string; title: string; weight: number }) => {
      const sub = (examSubs ?? []).find(
        (s: { exam_id: string; user_id: string }) => s.exam_id === e.id && s.user_id === userId,
      );
      return {
        titulo: e.title,
        nota: effectiveScore(sub ?? null),
        peso: Number(e.weight ?? 0),
        tipo: "examen" as const,
      };
    });
    const talleres: ItemCtx[] = (workshops ?? []).map((w: { id: string; title: string; weight: number }) => {
      const sub = (wsSubs ?? []).find(
        (s: { workshop_id: string; user_id: string }) => s.workshop_id === w.id && s.user_id === userId,
      );
      return {
        titulo: w.title,
        nota: effectiveScore(sub ?? null),
        peso: Number(w.weight ?? 0),
        tipo: "taller" as const,
      };
    });
    const proyectos: ItemCtx[] = projects.map((p2) => {
      const sub = (prjSubs ?? []).find(
        (s: { project_id: string; user_id: string }) => s.project_id === p2.id && s.user_id === userId,
      );
      return {
        titulo: p2.title,
        nota: effectiveScore(sub ?? null),
        peso: Number(p2.weight ?? 0),
        tipo: "proyecto" as const,
      };
    });

    // Asistencia general
    const asistencia = attendanceFor(userId, sessIds, (attRecs ?? []) as Array<{ session_id: string; user_id: string; status: string }>);

    // Cortes: nota del corte = ponderado de items + asistencia DEL corte
    const cortes: CutCtx[] = ((cuts ?? []) as Array<{ id: string; name: string; weight: number; attendance_weight: number }>).map((cut) => {
      const cutExams = (exams ?? []).filter((e: { cut_id: string | null }) => e.cut_id === cut.id);
      const cutWs = (workshops ?? []).filter((w: { cut_id: string | null }) => w.cut_id === cut.id);
      const cutPrjs = projects.filter((p2) => p2.cut_id === cut.id);
      const cutSessIds = ((sessions ?? []) as Array<{ id: string; cut_id: string | null }>)
        .filter((s) => s.cut_id === cut.id)
        .map((s) => s.id);

      const items: GradedItem[] = [];
      for (const e of cutExams) {
        const sub = (examSubs ?? []).find(
          (s: { exam_id: string; user_id: string }) => s.exam_id === e.id && s.user_id === userId,
        );
        items.push({ weight: Number(e.weight ?? 0), score: effectiveScore(sub ?? null) });
      }
      for (const w of cutWs) {
        const sub = (wsSubs ?? []).find(
          (s: { workshop_id: string; user_id: string }) => s.workshop_id === w.id && s.user_id === userId,
        );
        items.push({ weight: Number(w.weight ?? 0), score: effectiveScore(sub ?? null) });
      }
      for (const p2 of cutPrjs) {
        const sub = (prjSubs ?? []).find(
          (s: { project_id: string; user_id: string }) => s.project_id === p2.id && s.user_id === userId,
        );
        items.push({ weight: Number(p2.weight ?? 0), score: effectiveScore(sub ?? null) });
      }
      // Asistencia del corte
      if (cutSessIds.length > 0 && cut.attendance_weight > 0) {
        const cutAtt = attendanceFor(userId, cutSessIds, (attRecs ?? []) as Array<{ session_id: string; user_id: string; status: string }>);
        const attScore = (cutAtt.porcentaje / 100) * escalaMax;
        items.push({ weight: Number(cut.attendance_weight ?? 0), score: attScore });
      }
      const nota = computeWeightedGrade(items);
      return { nombre: cut.name, peso: Number(cut.weight ?? 0), nota };
    });

    // Nota final del curso (a partir de los cortes)
    const finalItems: GradedItem[] = cortes.map((c) => ({ weight: c.peso, score: c.nota }));
    const notaFinal = computeWeightedGrade(finalItems);

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
