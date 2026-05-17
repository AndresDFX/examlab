/**
 * Edge Function: student-calendar-ics
 *
 * Sirve un archivo .ics suscribible para el estudiante con TODOS los
 * eventos académicos relevantes:
 *   - Exámenes con ventana (start_time → end_time)
 *   - Talleres con due_date (all-day)
 *   - Proyectos con due_date (all-day)
 *   - Sesiones de asistencia (con start_time + meeting_url si aplica)
 *
 * Autenticación: por TOKEN en query string (NO requiere JWT). Esto es
 * lo que permite suscribirse desde Google/Outlook/Apple Calendar — los
 * clientes no envían JWT, solo GET a una URL fija. El token actúa como
 * shared secret estilo "private URL" de Google Calendar.
 *
 * Endpoint:
 *   GET /functions/v1/student-calendar-ics?token=<32 chars>
 *
 * Response:
 *   Content-Type: text/calendar; charset=utf-8
 *   Cache-Control: public, max-age=300 (5 min — balance entre fresh y carga)
 */
import { adminClient as admin, corsHeaders } from "../_shared/admin.ts";
import { buildIcs, type IcsEvent } from "./ics-builder.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.trim() ?? "";

  if (!token || token.length < 16) {
    return new Response("Token inválido", {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Resolver token → user_id (RPC SECURITY DEFINER, también actualiza last_accessed_at)
  const { data: userId, error: tokErr } = await admin.rpc("resolve_calendar_token", { _token: token });
  if (tokErr || !userId) {
    return new Response("Token no encontrado o revocado", {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Cargamos en paralelo todas las fuentes de eventos del estudiante.
  // Solo eventos del SEMESTRE actual hacia adelante (lookback 30 días
  // para que el cliente conserve los recientes vencidos en su histórico).
  const lookbackIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const lookbackDate = lookbackIso.slice(0, 10);

  const [examsRes, workshopsRes, projectsRes, sessionsRes] = await Promise.all([
    // EXÁMENES: asignados al usuario, con ventana definida y status publicado
    admin
      .from("exam_assignments")
      .select(
        "exam_id, exams(id, title, start_time, end_time, course_id, status, courses(name))",
      )
      .eq("user_id", userId)
      .gte("exams.end_time", lookbackIso),
    // TALLERES: solo course_enrollments del estudiante, talleres publicados con due_date
    admin
      .from("course_enrollments")
      .select(
        "course_id, courses(id, name, workshops(id, title, due_date, status))",
      )
      .eq("user_id", userId),
    // PROYECTOS: vía project_assignments + project_courses + course_enrollments (mixto)
    admin
      .from("course_enrollments")
      .select(
        "course_id, courses(id, name, projects(id, title, due_date, status))",
      )
      .eq("user_id", userId),
    // SESIONES de asistencia: solo de cursos donde el estudiante está matriculado
    admin
      .from("course_enrollments")
      .select(
        "course_id, courses(id, name, attendance_sessions(id, session_date, start_time, title, meeting_url))",
      )
      .eq("user_id", userId),
  ]);

  const events: IcsEvent[] = [];

  // ─── Exámenes ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (examsRes.data ?? []) as any[]) {
    const exam = row.exams;
    if (!exam || !exam.start_time || !exam.end_time) continue;
    if (exam.status && exam.status !== "publicado") continue;
    const courseName = exam.courses?.name ?? "Curso";
    events.push({
      uid: `exam-${exam.id}@examlab`,
      summary: `Examen: ${exam.title}`,
      description: `Curso: ${courseName}`,
      start: new Date(exam.start_time),
      end: new Date(exam.end_time),
      url: `${url.origin.replace(/\.supabase\.co.*$/, "")}/app/student/exams`,
      category: "EXAM",
    });
  }

  // ─── Talleres ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const enr of (workshopsRes.data ?? []) as any[]) {
    const course = enr.courses;
    if (!course?.workshops) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const ws of course.workshops as any[]) {
      if (!ws.due_date) continue;
      if (ws.status && ws.status !== "published") continue;
      if (String(ws.due_date) < lookbackDate) continue;
      const due = new Date(ws.due_date);
      // Si el due_date trae solo fecha (date), tratamos como all-day.
      // Si trae hora específica (timestamptz), usamos hora exacta.
      const hasTime = /T\d{2}:\d{2}/.test(String(ws.due_date));
      events.push({
        uid: `workshop-${ws.id}@examlab`,
        summary: `Taller: ${ws.title}`,
        description: `Curso: ${course.name}. Vence ${due.toISOString()}.`,
        start: due,
        end: hasTime ? new Date(due.getTime() + 30 * 60_000) : undefined,
        allDay: !hasTime,
        category: "WORKSHOP",
      });
    }
  }

  // ─── Proyectos ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const enr of (projectsRes.data ?? []) as any[]) {
    const course = enr.courses;
    if (!course?.projects) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pj of course.projects as any[]) {
      if (!pj.due_date) continue;
      if (pj.status && pj.status !== "published") continue;
      if (String(pj.due_date) < lookbackDate) continue;
      const due = new Date(pj.due_date);
      const hasTime = /T\d{2}:\d{2}/.test(String(pj.due_date));
      events.push({
        uid: `project-${pj.id}@examlab`,
        summary: `Proyecto: ${pj.title}`,
        description: `Curso: ${course.name}. Vence ${due.toISOString()}.`,
        start: due,
        end: hasTime ? new Date(due.getTime() + 30 * 60_000) : undefined,
        allDay: !hasTime,
        category: "PROJECT",
      });
    }
  }

  // ─── Sesiones de asistencia ─────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const enr of (sessionsRes.data ?? []) as any[]) {
    const course = enr.courses;
    if (!course?.attendance_sessions) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of course.attendance_sessions as any[]) {
      if (!s.session_date) continue;
      if (String(s.session_date) < lookbackDate) continue;
      // session_date es DATE; start_time es TIME (HH:MM:SS). Combinamos.
      const dateStr = String(s.session_date);
      const timeStr = s.start_time ? String(s.start_time).slice(0, 5) : null;
      const start = timeStr
        ? new Date(`${dateStr}T${timeStr}:00-05:00`)  // Colombia -05
        : new Date(`${dateStr}T00:00:00-05:00`);
      const summary = s.title ? `Clase: ${s.title}` : `Clase del curso ${course.name}`;
      events.push({
        uid: `session-${s.id}@examlab`,
        summary,
        description: `Curso: ${course.name}`,
        start,
        end: timeStr ? new Date(start.getTime() + 90 * 60_000) : undefined,
        allDay: !timeStr,
        location: s.meeting_url ?? undefined,
        url: s.meeting_url ?? undefined,
        category: "SESSION",
      });
    }
  }

  // ─── Construir y devolver ─────────────────────────────────────────
  const ics = buildIcs({
    calendarName: "Mi calendario ExamLab",
    events,
    timezone: "America/Bogota",
    now: new Date(),
  });

  return new Response(ics, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Content-Disposition": 'inline; filename="examlab.ics"',
    },
  });
});
