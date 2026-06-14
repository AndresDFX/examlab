// Edge function: calendar-ics
//
// Genera un feed ICS (RFC 5545) con todas las sesiones de los cursos
// en los que el usuario autenticado está matriculado o es docente.
// El estudiante suscribe esta URL UNA VEZ en Google Calendar / iOS
// Calendar / Outlook, y el cliente refresca el feed automáticamente
// cada ~12-24h. Cualquier cambio que el docente haga en la plataforma
// (mover fecha, cambiar título, agregar enlace de Meet) aparece en el
// calendario del estudiante sin que tengamos que pushear nada.
//
// Formato del URL: GET /functions/v1/calendar-ics
// Auth: Bearer JWT del usuario (lo inyecta el cliente Supabase).
//
// Devuelve text/calendar con un VCALENDAR + un VEVENT por sesión.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Escapa los chars que ICS reserva: comma, semicolon, backslash, newline. */
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Convierte una fecha ISO (YYYY-MM-DD) o ISO datetime a formato ICS
 *  UTC: YYYYMMDDTHHMMSSZ. Si solo viene fecha sin hora, asumimos
 *  09:00 local del servidor convertido a UTC — el docente típicamente
 *  programa "Clase del 15 de mayo" sin hora explícita y queremos que
 *  caiga en la mañana. Para sesiones con hora explícita en futuro,
 *  agregaremos un campo `session_time` separado. */
function toIcsTime(dateStr: string, startTime: string | null): string {
  // Si la sesión tiene `start_time` lo usamos como hora local de Bogotá
  // (UTC-5). Si no, mantenemos el legado de 09:00 UTC para sesiones
  // viejas sin hora explícita.
  let d: Date;
  if (dateStr.length === 10) {
    if (startTime && /^\d{2}:\d{2}/.test(startTime)) {
      const normTime = startTime.length === 5 ? `${startTime}:00` : startTime;
      d = new Date(`${dateStr}T${normTime}-05:00`);
    } else {
      d = new Date(`${dateStr}T09:00:00Z`);
    }
  } else {
    d = new Date(dateStr);
  }
  if (Number.isNaN(d.getTime())) return "19700101T000000Z";
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Línea ICS con folding RFC 5545: ninguna línea puede exceder 75
 *  octetos. Las líneas largas se parten con CRLF + espacio. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 73) {
    out.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
  }
  return out.join("\r\n");
}

interface SessionRow {
  id: string;
  course_id: string;
  session_date: string;
  /** HH:MM:SS local Bogotá; null para sesiones legacy sin hora. */
  start_time: string | null;
  /** Minutos; null/<=0 → fallback 90 (igual que la edge `calendar`). */
  duration_minutes: number | null;
  title: string | null;
  meeting_url: string | null;
}
interface CourseRow {
  id: string;
  name: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Resolver el usuario desde el JWT que viene en Authorization. Sin
  // JWT no hay calendario que mostrar — devolvemos 401.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: userRes, error: userErr } = await adminClient.auth.getUser(token);
  if (userErr || !userRes?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userRes.user.id;

  // Cursos del usuario: matriculado (estudiante) O docente. Hacemos las
  // dos consultas en paralelo y unimos por id.
  const [enrRes, teachRes] = await Promise.all([
    adminClient.from("course_enrollments").select("course_id").eq("user_id", userId),
    adminClient.from("course_teachers").select("course_id").eq("teacher_id", userId),
  ]);
  const courseIds = Array.from(
    new Set([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...((enrRes.data ?? []) as any[]).map((r) => r.course_id as string),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...((teachRes.data ?? []) as any[]).map((r) => r.course_id as string),
    ]),
  );

  if (courseIds.length === 0) {
    // Devolvemos un calendario vacío válido — evita que el cliente
    // marque el feed como roto.
    const empty = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ExamLab//Course Schedule//ES",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:ExamLab — Mis cursos",
      "END:VCALENDAR",
    ].join("\r\n");
    return new Response(empty, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=900",
      },
    });
  }

  const [coursesRes, sessionsRes] = await Promise.all([
    adminClient.from("courses").select("id, name").in("id", courseIds),
    adminClient
      .from("attendance_sessions")
      .select("id, course_id, session_date, start_time, duration_minutes, title, meeting_url")
      .in("course_id", courseIds)
      // Papelera: una sesión en soft-delete NO debe aparecer como VEVENT en
      // el calendario externo suscrito hasta que se restaure.
      .is("deleted_at", null)
      .order("session_date", { ascending: true }),
  ]);

  const courseById = new Map<string, string>();
  for (const c of ((coursesRes.data ?? []) as CourseRow[]) ?? []) {
    courseById.set(c.id, c.name);
  }

  const sessions = (sessionsRes.data ?? []) as SessionRow[];

  // DTSTAMP es el momento en que el servidor genera el feed (no la
  // fecha del evento). Lo usamos también como base para el UID stable.
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ExamLab//Course Schedule//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:ExamLab — Mis cursos",
    "X-WR-TIMEZONE:UTC",
    // Refresh hint: el cliente refresca el feed cada ~12h. Google
    // suele respetarlo; iOS/Outlook lo usan como pista.
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];

  for (const s of sessions) {
    const start = toIcsTime(s.session_date, s.start_time);
    // Construye la fecha de inicio con la MISMA lógica que toIcsTime
    // para que start + duración produzcan un end consistente. Si la
    // sesión declaró `start_time` lo usamos como hora local Bogotá;
    // si no, fallback al legacy 09:00 UTC.
    const startDate =
      s.session_date.length === 10
        ? s.start_time && /^\d{2}:\d{2}/.test(s.start_time)
          ? new Date(
              `${s.session_date}T${s.start_time.length === 5 ? `${s.start_time}:00` : s.start_time}-05:00`,
            )
          : new Date(`${s.session_date}T09:00:00Z`)
        : new Date(s.session_date);
    const durationMin = s.duration_minutes && s.duration_minutes > 0 ? s.duration_minutes : 90;
    const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000);
    const end = endDate
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const courseName = courseById.get(s.course_id) ?? "Curso";
    const summary = s.title ? `${courseName}: ${s.title}` : `${courseName} — ${s.session_date}`;
    const descLines: string[] = [];
    if (s.meeting_url) descLines.push(`Reunión: ${s.meeting_url}`);
    descLines.push(`Curso: ${courseName}`);
    const description = descLines.join("\\n");

    lines.push("BEGIN:VEVENT");
    lines.push(fold(`UID:${s.id}@examlab`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end}`);
    lines.push(fold(`SUMMARY:${icsEscape(summary)}`));
    lines.push(fold(`DESCRIPTION:${icsEscape(description)}`));
    if (s.meeting_url) {
      lines.push(fold(`URL:${s.meeting_url}`));
      lines.push(fold(`LOCATION:${icsEscape(s.meeting_url)}`));
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/calendar; charset=utf-8",
      // Cache 15 min — el cliente del calendario suele consultar más
      // espaciado, pero damos un poco de margen para no machacar la BD.
      "Cache-Control": "public, max-age=900",
    },
  });
});
