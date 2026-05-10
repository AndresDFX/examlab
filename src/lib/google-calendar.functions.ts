// Server functions de Google Calendar para los docentes.
// Cada docente conecta SU PROPIA cuenta vía OAuth con nuestro client_id, y
// estos endpoints leen sus calendarios y crean eventos con Google Meet.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import { buildAuthUrl, callGoogle } from "./google-calendar.server";

/** Devuelve la URL para iniciar el flujo OAuth. El "state" es el teacher_id
 *  + nonce. El callback público lo valida. */
export const getGoogleAuthUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { origin: string }) =>
    z.object({ origin: z.string().url() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const nonce = crypto.randomUUID();
    // state opaco: <teacher_id>:<nonce>:<origin_b64>. El callback lo parsea
    // y usa el origin para construir el redirect_uri y para volver al
    // mismo dominio donde el usuario inició (preview vs published).
    const originB64 = Buffer.from(data.origin).toString("base64url");
    const state = `${userId}:${nonce}:${originB64}`;
    return { url: buildAuthUrl(state, data.origin) };
  });

/** Estado actual: ¿está conectado?, ¿qué calendario tiene seleccionado? */
export const getGoogleStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await supabaseAdmin
      .from("teacher_google_tokens")
      .select("calendar_id, calendar_name, google_email, updated_at")
      .eq("teacher_id", context.userId)
      .maybeSingle();
    return { connected: !!data, ...data };
  });

interface GCalListItem {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

/** Lista los calendarios del docente (los que puede leer/escribir). */
export const listMyCalendars = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const res = await callGoogle<{ items: GCalListItem[] }>(
      context.userId,
      "/calendar/v3/users/me/calendarList?minAccessRole=writer",
    );
    return {
      calendars: (res.items ?? []).map((c) => ({
        id: c.id,
        name: c.summary,
        primary: !!c.primary,
      })),
    };
  });

/** Persiste el calendario elegido por el docente. */
export const setSelectedCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { calendarId: string; calendarName: string }) =>
    z.object({
      calendarId: z.string().min(1).max(500),
      calendarName: z.string().min(1).max(500),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("teacher_google_tokens")
      .update({ calendar_id: data.calendarId, calendar_name: data.calendarName })
      .eq("teacher_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Desconecta (borra los tokens). El docente puede reconectar después. */
export const disconnectGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await supabaseAdmin
      .from("teacher_google_tokens")
      .delete()
      .eq("teacher_id", context.userId);
    return { ok: true };
  });

interface GCalEvent {
  id: string;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri: string; entryPointType: string }> };
}

function toIsoEvent(dateStr: string, durationMin = 90): { start: string; end: string } {
  // session_date en attendance_sessions es DATE puro. Anclamos 09:00 hora
  // local de Bogotá (UTC-5) y duramos `durationMin` por defecto.
  const start = new Date(`${dateStr}T09:00:00-05:00`);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Sincroniza TODAS las sesiones del curso (pasadas y futuras) con Google.
 *  - Sesiones sin google_event_id: crea evento con Meet + invita correos.
 *  - Sesiones con google_event_id: hace patch (idempotente).
 *  Persiste meeting_url y google_event_id de vuelta. */
export const syncCourseSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { courseId: string }) =>
    z.object({ courseId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;

    // 1. Verificar que el docente sea del curso.
    const { data: ct } = await supabaseAdmin
      .from("course_teachers")
      .select("course_id")
      .eq("course_id", data.courseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!ct) throw new Error("No sos docente de este curso");

    // 2. Verificar conexión + calendario seleccionado.
    const { data: tok } = await supabaseAdmin
      .from("teacher_google_tokens")
      .select("calendar_id")
      .eq("teacher_id", userId)
      .maybeSingle();
    if (!tok?.calendar_id) throw new Error("Seleccioná un calendario primero");
    const calId = encodeURIComponent(tok.calendar_id);

    // 3. Curso + sesiones + emails de matriculados.
    const [{ data: course }, { data: sessions }, { data: enrolls }] = await Promise.all([
      supabaseAdmin.from("courses").select("name").eq("id", data.courseId).single(),
      supabaseAdmin
        .from("attendance_sessions")
        .select("id, title, session_date, google_event_id, meeting_url")
        .eq("course_id", data.courseId)
        .order("session_date", { ascending: true }),
      supabaseAdmin
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", data.courseId),
    ]);

    const studentIds = (enrolls ?? []).map((e) => e.user_id);
    let attendees: Array<{ email: string }> = [];
    if (studentIds.length > 0) {
      const { data: profs } = await supabaseAdmin
        .from("profiles")
        .select("institutional_email")
        .in("id", studentIds);
      attendees = (profs ?? [])
        .map((p) => p.institutional_email)
        .filter((e): e is string => !!e && e.includes("@"))
        .map((email) => ({ email }));
    }

    let created = 0, updated = 0, failed = 0;
    const errors: string[] = [];

    for (const s of sessions ?? []) {
      try {
        const { start, end } = toIsoEvent(s.session_date);
        const summary = s.title
          ? `${course?.name ?? "Curso"}: ${s.title}`
          : `${course?.name ?? "Curso"} — ${s.session_date}`;
        const body = {
          summary,
          description: `Sesión sincronizada desde ExamLab.\nCurso: ${course?.name ?? ""}`,
          start: { dateTime: start, timeZone: "America/Bogota" },
          end: { dateTime: end, timeZone: "America/Bogota" },
          attendees,
          guestsCanSeeOtherGuests: false,
          reminders: { useDefault: true },
        };

        if (s.google_event_id) {
          // PATCH idempotente — no recreamos Meet, lo conservamos.
          await callGoogle<GCalEvent>(
            userId,
            `/calendar/v3/calendars/${calId}/events/${encodeURIComponent(s.google_event_id)}?sendUpdates=all`,
            { method: "PATCH", body: JSON.stringify(body) },
          );
          updated++;
        } else {
          // INSERT con conferenceData → genera link de Meet.
          const ev = await callGoogle<GCalEvent>(
            userId,
            `/calendar/v3/calendars/${calId}/events?conferenceDataVersion=1&sendUpdates=all`,
            {
              method: "POST",
              body: JSON.stringify({
                ...body,
                conferenceData: {
                  createRequest: {
                    requestId: `examlab-${s.id}`,
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                  },
                },
              }),
            },
          );
          const meetLink =
            ev.hangoutLink ||
            ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
            null;
          await supabaseAdmin
            .from("attendance_sessions")
            .update({ google_event_id: ev.id, meeting_url: meetLink })
            .eq("id", s.id);
          created++;
        }
      } catch (e) {
        failed++;
        errors.push(`Sesión ${s.session_date}: ${(e as Error).message}`);
      }
    }

    return { created, updated, failed, total: (sessions ?? []).length, errors };
  });
