// Edge function "calendar" — RPC unificado para todas las operaciones
// del módulo Calendario del docente. Una sola function para reducir
// archivos a mantener.
//
// Acciones soportadas (`{ action }` en el body):
//   - status              → ¿conectado?, calendario actual, provider
//   - init                → URL de OAuth para conectar (provider)
//   - list                → lista de calendarios del docente
//   - select              → guarda el calendar_id elegido
//   - disconnect          → borra los tokens
//   - sync                → crea/actualiza eventos del curso en Calendar
//
// Diseño multi-provider:
//   Hoy solo Google. Cuando agreguemos Microsoft, este file delega al
//   `_shared/calendar-microsoft.ts` según `provider`. La row de
//   teacher_google_tokens tiene una columna `provider` (default 'google').

import {
  adminClient,
  buildGoogleAuthUrl,
  callGoogle,
  corsHeaders,
  getUserIdFromRequest,
} from "../_shared/calendar-google.ts";

interface BaseBody {
  action: "status" | "init" | "list" | "select" | "disconnect" | "sync";
  provider?: "google" | "microsoft";
}
interface InitBody extends BaseBody {
  action: "init";
  origin: string; // URL del frontend para volver después del callback
}
interface SelectBody extends BaseBody {
  action: "select";
  calendarId: string;
  calendarName: string;
}
interface SyncBody extends BaseBody {
  action: "sync";
  courseId: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }

  const userId = await getUserIdFromRequest(req);
  if (!userId) return jsonError("unauthorized", 401);

  let body: BaseBody;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  const provider = body.provider ?? "google";
  if (provider !== "google") {
    return jsonError("provider_not_supported_yet", 400);
  }

  try {
    switch (body.action) {
      case "status":
        return await handleStatus(userId);
      case "init":
        return await handleInit(userId, body as InitBody);
      case "list":
        return await handleList(userId);
      case "select":
        return await handleSelect(userId, body as SelectBody);
      case "disconnect":
        return await handleDisconnect(userId);
      case "sync":
        return await handleSync(userId, body as SyncBody);
      default:
        return jsonError("unknown_action", 400);
    }
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
});

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonOk(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ────────── Handlers ──────────

async function handleStatus(userId: string) {
  const { data } = await adminClient
    .from("teacher_google_tokens")
    .select("provider, provider_email, google_email, calendar_id, calendar_name, updated_at")
    .eq("teacher_id", userId)
    .maybeSingle();
  return jsonOk({
    connected: !!data,
    provider: data?.provider ?? null,
    provider_email: data?.provider_email ?? data?.google_email ?? null,
    calendar_id: data?.calendar_id ?? null,
    calendar_name: data?.calendar_name ?? null,
    updated_at: data?.updated_at ?? null,
  });
}

// OAUTH-5: allowlist de origins permitidos para redirect post-callback.
// Cualquier dominio fuera de esta lista se rechaza para evitar open-redirect.
const ALLOWED_ORIGINS_RE = [
  /^https:\/\/[a-z0-9-]+\.lovable\.app$/i,
  /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/i,
  /^https:\/\/examlab\.lovable\.app$/i,
  /^http:\/\/localhost(:\d+)?$/i,
];
function isAllowedOrigin(o: string): boolean {
  try {
    const u = new URL(o);
    const origin = `${u.protocol}//${u.host}`;
    return ALLOWED_ORIGINS_RE.some((re) => re.test(origin));
  } catch {
    return false;
  }
}

async function handleInit(userId: string, body: InitBody) {
  if (!body.origin || !/^https?:\/\//.test(body.origin)) {
    return jsonError("origin_required", 400);
  }
  if (!isAllowedOrigin(body.origin)) {
    return jsonError("origin_not_allowed", 400);
  }
  const nonce = crypto.randomUUID();
  // state opaco — el callback lo cruza contra calendar_oauth_states para
  // validar one-time + extraer origin sin confiar en lo que mande Google.
  const originB64 = btoa(body.origin).replace(/=+$/, "");
  const state = `${userId}:${nonce}:${originB64}`;

  // OAUTH-1/2: persistir el state con expiración 10min para validación one-time.
  const { error: stErr } = await adminClient.from("calendar_oauth_states").insert({
    state,
    teacher_id: userId,
    provider: "google",
    origin: body.origin,
    nonce,
  });
  if (stErr) throw new Error(`oauth_state_insert_failed: ${stErr.message}`);

  return jsonOk({ url: buildGoogleAuthUrl(state) });
}

interface GCalListItem {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

async function handleList(userId: string) {
  const res = await callGoogle<{ items: GCalListItem[] }>(
    userId,
    "/calendar/v3/users/me/calendarList?minAccessRole=writer",
  );
  const calendars = (res.items ?? []).map((c) => ({
    id: c.id,
    name: c.summary,
    primary: !!c.primary,
  }));
  return jsonOk({ calendars });
}

async function handleSelect(userId: string, body: SelectBody) {
  if (!body.calendarId || !body.calendarName) {
    return jsonError("calendar_required", 400);
  }
  const { error } = await adminClient
    .from("teacher_google_tokens")
    .update({ calendar_id: body.calendarId, calendar_name: body.calendarName })
    .eq("teacher_id", userId);
  if (error) throw new Error(error.message);
  return jsonOk({});
}

/**
 * Inserta directo en audit_logs porque acá el caller SÍ está autenticado
 * (lo validamos arriba con getUserIdFromRequest), pero usamos adminClient
 * para escribir — preferimos no exigir RLS para auditoría server-side.
 */
async function audit(
  userId: string,
  action: string,
  severity: "info" | "warning" | "error",
  metadata: Record<string, unknown>,
  entityName: string | null = null,
) {
  try {
    const { data: u } = await adminClient.auth.admin.getUserById(userId);
    const { data: r } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    await adminClient.from("audit_logs").insert({
      actor_id: userId,
      actor_email: u?.user?.email ?? null,
      actor_role: r?.role ?? "Docente",
      action,
      category: "system",
      severity,
      entity_type: "calendar_connection",
      entity_id: userId,
      entity_name: entityName,
      metadata,
    });
  } catch (_) {
    /* best-effort */
  }
}

async function handleDisconnect(userId: string) {
  const { data: tok } = await adminClient
    .from("teacher_google_tokens")
    .select("provider, provider_email, google_email, refresh_token, access_token")
    .eq("teacher_id", userId)
    .maybeSingle();

  // OAUTH-4: revocar el token en Google ANTES de borrar localmente.
  // Best-effort — si falla (ya revocado, red caída) seguimos con el delete
  // local: el docente igual queda desconectado del lado app.
  const tokenToRevoke = tok?.refresh_token ?? tok?.access_token;
  if (tokenToRevoke) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokenToRevoke }),
      });
    } catch (_) {
      /* best-effort */
    }
  }

  await adminClient.from("teacher_google_tokens").delete().eq("teacher_id", userId);
  await audit(
    userId,
    "calendar.disconnected",
    "info",
    {
      provider: tok?.provider ?? "google",
      provider_email: tok?.provider_email ?? tok?.google_email ?? null,
      revoked: !!tokenToRevoke,
    },
    "Google Calendar",
  );
  return jsonOk({});
}

interface GCalEvent {
  id: string;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri: string; entryPointType: string }> };
}

function toIsoEvent(dateStr: string, durationMin = 90): { start: string; end: string } {
  // session_date es DATE puro (YYYY-MM-DD). Lo anclamos a 09:00 hora
  // local de Bogotá (UTC-5) — TODO V2: tomar la hora real cuando la
  // tabla la guarde.
  const start = new Date(`${dateStr}T09:00:00-05:00`);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function handleSync(userId: string, body: SyncBody) {
  if (!body.courseId) return jsonError("course_required", 400);

  // 1) Validar que el docente es del curso.
  const { data: ct } = await adminClient
    .from("course_teachers")
    .select("course_id")
    .eq("course_id", body.courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!ct) return jsonError("not_teacher_of_course", 403);

  // 2) Verificar conexión + calendario seleccionado.
  const { data: tok } = await adminClient
    .from("teacher_google_tokens")
    .select("calendar_id")
    .eq("teacher_id", userId)
    .maybeSingle();
  if (!tok?.calendar_id) return jsonError("no_calendar_selected", 400);
  const calId = encodeURIComponent(tok.calendar_id);

  // 3) Curso + sesiones + emails de matriculados (en paralelo).
  const [{ data: course }, { data: sessions }, { data: enrolls }] = await Promise.all([
    adminClient.from("courses").select("name").eq("id", body.courseId).maybeSingle(),
    adminClient
      .from("attendance_sessions")
      .select("id, title, session_date, google_event_id, meeting_url")
      .eq("course_id", body.courseId)
      .order("session_date", { ascending: true }),
    adminClient.from("course_enrollments").select("user_id").eq("course_id", body.courseId),
  ]);

  const studentIds = (enrolls ?? []).map((e: { user_id: string }) => e.user_id);
  let attendees: Array<{ email: string }> = [];
  if (studentIds.length > 0) {
    const { data: profs } = await adminClient
      .from("profiles")
      .select("institutional_email")
      .in("id", studentIds);
    attendees = (profs ?? [])
      .map((p: { institutional_email: string | null }) => p.institutional_email)
      .filter((e: string | null): e is string => !!e && e.includes("@"))
      .map((email: string) => ({ email }));
  }

  let created = 0,
    updated = 0,
    failed = 0;
  const errors: string[] = [];

  for (const s of sessions ?? []) {
    try {
      const { start, end } = toIsoEvent(s.session_date);
      const summary = s.title
        ? `${course?.name ?? "Curso"}: ${s.title}`
        : `${course?.name ?? "Curso"} — ${s.session_date}`;
      const eventBody = {
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
          { method: "PATCH", body: JSON.stringify(eventBody) },
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
              ...eventBody,
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
        await adminClient
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

  await audit(
    userId,
    failed > 0 && created + updated === 0 ? "calendar.sync_failed" : "calendar.synced",
    failed > 0 && created + updated === 0 ? "error" : "info",
    {
      provider: "google",
      course_id: body.courseId,
      course_name: course?.name ?? null,
      calendar_id: tok.calendar_id,
      created,
      updated,
      failed,
      total: (sessions ?? []).length,
      first_errors: errors.slice(0, 3),
    },
    course?.name ?? null,
  );

  return jsonOk({
    created,
    updated,
    failed,
    total: (sessions ?? []).length,
    errors,
  });
}
