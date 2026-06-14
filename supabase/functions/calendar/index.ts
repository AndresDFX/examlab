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
  isGoogleEventGoneError,
} from "../_shared/calendar-google.ts";
import {
  buildMicrosoftAuthUrl,
  callMicrosoft,
  isMicrosoftEventGoneError,
} from "../_shared/calendar-microsoft.ts";

type Provider = "google" | "microsoft";

interface BaseBody {
  action:
    | "status"
    | "init"
    | "list"
    | "select"
    | "disconnect"
    | "sync"
    | "sync_poll_to_calendar"
    | "list_events"
    | "link_events_to_sessions"
    | "cron_sync_recordings";
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
/** Sincroniza una encuesta de CUPO (poll_type='slot') al calendario del
 *  docente creando UN evento por cada estudiante matriculado en los cursos
 *  de la encuesta (con el docente como invitado). Re-sincronizar ACTUALIZA
 *  los eventos ya creados (idempotente vía tabla poll_calendar_events).
 *  Solo aplica a encuestas de cupo — los demás tipos se rechazan. */
interface SyncPollToCalendarBody extends BaseBody {
  action: "sync_poll_to_calendar";
  pollId: string;
}
/** Lista eventos del calendario seleccionado dentro de una ventana
 *  temporal. Se usa en el flujo INVERSO al sync: el docente ya tiene
 *  los eventos creados en Google Calendar (con sus Meet/Zoom URLs) y
 *  quiere ASOCIAR uno a uno con las sesiones existentes en ExamLab —
 *  caso típico de cursos donde el cronograma fue armado en Google
 *  antes que en ExamLab. */
interface ListEventsBody extends BaseBody {
  action: "list_events";
  /** ISO date (YYYY-MM-DD). Inclusive. */
  fromDate: string;
  /** ISO date (YYYY-MM-DD). Inclusive (end of day, hora 23:59). */
  toDate: string;
}
/** Asocia uno o más eventos de Google Calendar a sesiones existentes
 *  en ExamLab. NO crea eventos nuevos (eso lo hace `sync`). Pull desde
 *  el calendar: setea `attendance_sessions.google_event_id` +
 *  `meeting_url` con los datos del evento. */
interface LinkEventsBody extends BaseBody {
  action: "link_events_to_sessions";
  courseId: string;
  /** Mapping uno-a-uno session → event. Si una sesión ya tenía un
   *  google_event_id, se reemplaza por el nuevo. Para desvincular,
   *  pasar `eventId: null`. */
  links: Array<{ sessionId: string; eventId: string | null }>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }

  let body: BaseBody;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  const provider: Provider = body.provider === "microsoft" ? "microsoft" : "google";

  // Tarea programada (pg_cron): sincroniza automáticamente las
  // grabaciones/notas/enlaces de Calendar hacia las sesiones YA vinculadas
  // de TODOS los docentes con calendario conectado. No usa user JWT — se
  // autentica con el service_role key (la edge es verify_jwt=false y valida
  // internamente, mismo patrón que los workers de IA).
  if (body.action === "cron_sync_recordings") {
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!svc || bearer !== svc) return jsonError("unauthorized", 401);
    try {
      return await handleCronSyncRecordings();
    } catch (e) {
      return jsonError((e as Error).message, 500);
    }
  }

  const userId = await getUserIdFromRequest(req);
  if (!userId) return jsonError("unauthorized", 401);

  try {
    switch (body.action) {
      case "status":
        return await handleStatus(userId);
      case "init":
        return await handleInit(userId, body as InitBody, provider);
      case "list":
        return await handleList(userId, provider);
      case "select":
        return await handleSelect(userId, body as SelectBody);
      case "disconnect":
        return await handleDisconnect(userId);
      case "sync":
        return await handleSync(userId, body as SyncBody, provider);
      case "sync_poll_to_calendar":
        return await handleSyncPollToCalendar(
          userId,
          body as SyncPollToCalendarBody,
          provider,
        );
      case "list_events":
        return await handleListEvents(userId, body as ListEventsBody, provider);
      case "link_events_to_sessions":
        return await handleLinkEventsToSessions(userId, body as LinkEventsBody, provider);
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

async function handleInit(userId: string, body: InitBody, provider: Provider) {
  if (!body.origin || !/^https?:\/\//.test(body.origin)) {
    return jsonError("origin_required", 400);
  }
  if (!isAllowedOrigin(body.origin)) {
    return jsonError("origin_not_allowed", 400);
  }
  const nonce = crypto.randomUUID();
  // state opaco — el callback lo cruza contra calendar_oauth_states para
  // validar one-time + extraer origin sin confiar en lo que mande el provider.
  const originB64 = btoa(body.origin).replace(/=+$/, "");
  const state = `${userId}:${nonce}:${originB64}`;

  // OAUTH-1/2: persistir el state con provider para que el callback
  // sepa a qué proveedor pedir el token exchange. Expiración 10min.
  const { error: stErr } = await adminClient.from("calendar_oauth_states").insert({
    state,
    teacher_id: userId,
    provider,
    origin: body.origin,
    nonce,
  });
  if (stErr) throw new Error(`oauth_state_insert_failed: ${stErr.message}`);

  const url =
    provider === "microsoft" ? buildMicrosoftAuthUrl(state) : buildGoogleAuthUrl(state);
  return jsonOk({ url });
}

interface GCalListItem {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

interface MsCalendarListItem {
  id: string;
  name: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  owner?: { name?: string; address?: string };
}

async function handleList(userId: string, provider: Provider) {
  if (provider === "microsoft") {
    // Microsoft Graph: `/me/calendars` no soporta filter por permiso.
    // Filtramos client-side por `canEdit:true` para que el docente no
    // vea calendarios de solo lectura (compartidos) donde no podría
    // crear eventos.
    const res = await callMicrosoft<{ value: MsCalendarListItem[] }>(
      userId,
      "/me/calendars?$select=id,name,isDefaultCalendar,canEdit,owner&$top=100",
    );
    const calendars = (res.value ?? [])
      .filter((c) => c.canEdit !== false)
      .map((c) => ({ id: c.id, name: c.name, primary: !!c.isDefaultCalendar }));
    return jsonOk({ calendars });
  }
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

  const providerRow = (tok?.provider ?? "google") as Provider;
  let revoked = false;
  // Revoke en Google: best-effort vía /revoke. Microsoft NO expone un
  // endpoint análogo público; el token se invalida cuando borrás la
  // fila local (el siguiente refresh fallará y obligará reconexión).
  // Para revocación inmediata MS pediría `/me/revokeSignInSessions`,
  // pero eso desloguea TODAS las sesiones del usuario en el tenant —
  // demasiado invasivo para este flujo.
  if (providerRow === "google") {
    const tokenToRevoke = tok?.refresh_token ?? tok?.access_token;
    if (tokenToRevoke) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
        revoked = true;
      } catch (_) {
        /* best-effort */
      }
    }
  }

  await adminClient.from("teacher_google_tokens").delete().eq("teacher_id", userId);
  await audit(
    userId,
    "calendar.disconnected",
    "info",
    {
      provider: providerRow,
      provider_email: tok?.provider_email ?? tok?.google_email ?? null,
      revoked,
    },
    providerRow === "microsoft" ? "Outlook / Microsoft 365" : "Google Calendar",
  );
  return jsonOk({});
}

interface GCalEvent {
  id: string;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri: string; entryPointType: string }> };
}

/** Subset de Microsoft Graph Event que usamos. La response completa es
 *  más grande — pedimos solo lo necesario. */
interface MsEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  webLink?: string;
  /** Cuando el evento se creó con isOnlineMeeting=true Y la cuenta tiene
   *  licencia Teams habilitada, este campo trae el joinUrl. Si la
   *  cuenta NO puede crear Teams (sin licencia, Conditional Access
   *  bloqueado, tenant restringido), `onlineMeeting` viene null y el
   *  evento queda sin link. No falla — solo no hay Teams. */
  onlineMeeting?: { joinUrl?: string } | null;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isCancelled?: boolean;
}

function toIsoEvent(
  dateStr: string,
  startTime: string | null,
  durationMin: number | null,
): { start: string; end: string } {
  // session_date es DATE puro (YYYY-MM-DD). `start_time` viene como
  // "HH:MM:SS" (sin zona) — lo interpretamos como hora local de Bogotá.
  // Si no hay hora explícita, mantenemos el legado de 09:00 para no
  // romper sesiones viejas que no se actualizaron tras la migración.
  const timePart = startTime && /^\d{2}:\d{2}/.test(startTime) ? startTime : "09:00:00";
  // Aseguramos formato HH:MM:SS (Postgres a veces devuelve "09:00" sin segundos).
  const normTime = timePart.length === 5 ? `${timePart}:00` : timePart;
  const start = new Date(`${dateStr}T${normTime}-05:00`);
  const minutes = durationMin && durationMin > 0 ? durationMin : 90;
  const end = new Date(start.getTime() + minutes * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function handleSync(userId: string, body: SyncBody, provider: Provider) {
  if (!body.courseId) return jsonError("course_required", 400);

  // 1) Validar que el docente es del curso.
  const { data: ct } = await adminClient
    .from("course_teachers")
    .select("course_id")
    .eq("course_id", body.courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!ct) return jsonError("not_teacher_of_course", 403);

  // 2) Verificar conexión + calendario seleccionado. Validamos también
  // que la fila corresponda al provider solicitado — si el docente
  // está conectado a Google y la UI llama con provider=microsoft,
  // devolvemos un error claro en vez de hacer un fetch que falla.
  const { data: tok } = await adminClient
    .from("teacher_google_tokens")
    .select("calendar_id, provider")
    .eq("teacher_id", userId)
    .maybeSingle();
  if (!tok?.calendar_id) return jsonError("no_calendar_selected", 400);
  if ((tok.provider ?? "google") !== provider) {
    return jsonError("provider_mismatch", 409);
  }
  const calId = encodeURIComponent(tok.calendar_id);

  // Pre-check: ¿existe todavía el calendario? Si el docente lo borró en
  // su Calendar / Outlook o perdió acceso, el GET de metadata responde
  // 404 y NO tiene sentido intentar crear N eventos uno por uno (cada
  // uno daría 404 igual). Detectamos el caso una sola vez, limpiamos el
  // binding en DB y devolvemos un error claro pidiendo al docente que
  // reconecte / elija otro calendario.
  try {
    if (provider === "microsoft") {
      await callMicrosoft<{ id: string }>(userId, `/me/calendars/${calId}`, {
        method: "GET",
      });
    } else {
      await callGoogle<{ id: string }>(userId, `/calendar/v3/calendars/${calId}`, {
        method: "GET",
      });
    }
  } catch (e) {
    const isGone =
      provider === "microsoft" ? isMicrosoftEventGoneError(e) : isGoogleEventGoneError(e);
    if (isGone) {
      // 404/410 → el calendario seleccionado ya no es accesible.
      // Limpiamos `calendar_id` para que la UI pida re-seleccionar.
      await adminClient
        .from("teacher_google_tokens")
        .update({ calendar_id: null, calendar_name: null })
        .eq("teacher_id", userId);
      await audit(userId, "calendar.calendar_missing", "warning", {
        provider,
        course_id: body.courseId,
        calendar_id: tok.calendar_id,
      });
      return jsonError("calendar_not_accessible", 410);
    }
    throw e;
  }

  // Belt-and-suspenders: aunque el cliente filtra cursos sin sesiones
  // completas, validamos también server-side. Si llegara un sync con
  // sesiones sin start_time, abortamos antes de tocar Google — evita
  // que eventos queden con hora default 09:00 cuando el docente nunca
  // las configuró.
  const { count: missingCount } = await adminClient
    .from("attendance_sessions")
    .select("id", { count: "exact", head: true })
    .eq("course_id", body.courseId)
    // Papelera: no contar sesiones soft-deleted — una sesión borrada sin
    // hora NO debe abortar el sync (ni va a pushearse al calendario).
    .is("deleted_at", null)
    .is("start_time", null);
  if ((missingCount ?? 0) > 0) {
    return jsonError(`course_has_sessions_without_time:${missingCount}`, 400);
  }

  // 3) Curso + sesiones + emails de matriculados (en paralelo).
  const [{ data: course }, { data: sessions }, { data: enrolls }] = await Promise.all([
    adminClient.from("courses").select("name").eq("id", body.courseId).maybeSingle(),
    adminClient
      .from("attendance_sessions")
      .select("id, title, session_date, start_time, duration_minutes, google_event_id, meeting_url")
      .eq("course_id", body.courseId)
      // Papelera: una sesión soft-deleted NO debe pushearse al Google
      // Calendar / Microsoft Graph del docente ni de los alumnos.
      .is("deleted_at", null)
      .order("session_date", { ascending: true }),
    adminClient.from("course_enrollments").select("user_id").eq("course_id", body.courseId),
  ]);

  const studentIds = (enrolls ?? []).map((e: { user_id: string }) => e.user_id);
  // Emails canónicos de los alumnos matriculados — la transformación al
  // shape esperado por cada proveedor (responseStatus vs emailAddress)
  // ocurre cuando armamos cada eventBody, no acá.
  let studentEmails: string[] = [];
  if (studentIds.length > 0) {
    const { data: profs } = await adminClient
      .from("profiles")
      .select("institutional_email")
      .in("id", studentIds);
    studentEmails = (profs ?? [])
      .map((p: { institutional_email: string | null }) => p.institutional_email)
      .filter((e: string | null): e is string => !!e && e.includes("@"));
  }
  // Google: pre-aceptamos a los attendees con responseStatus="accepted"
  // para que el evento aparezca automaticamente en SU Google Calendar
  // sin que tengan que RSVP. Esto es importante porque Google Meet
  // muestra el `summary` del evento como nombre de la reunion SOLO si
  // el usuario tiene el evento en su calendar. Si entra al Meet por la
  // URL sin tener el evento, ve el meeting code (abc-defg-hij) en vez
  // del titulo legible. Pre-aceptar resuelve el caso comun.
  const googleAttendees = studentEmails.map((email) => ({
    email,
    responseStatus: "accepted" as const,
  }));
  // Microsoft: no permite pre-aceptar (responseStatus es read-only en
  // Graph). Cada attendee recibe la invitación normal en Outlook y
  // decide RSVP. `type=required` mantiene el comportamiento de "te
  // pediremos confirmación" — usar `optional` para ocultar la columna
  // de respuesta. Mantenemos `required` para paridad con Google.
  const msAttendees = studentEmails.map((email) => ({
    emailAddress: { address: email, name: email.split("@")[0] },
    type: "required" as const,
  }));

  let created = 0,
    updated = 0,
    failed = 0;
  const errors: string[] = [];

  for (const s of sessions ?? []) {
    try {
      const { start, end } = toIsoEvent(
        s.session_date,
        (s as { start_time?: string | null }).start_time ?? null,
        (s as { duration_minutes?: number | null }).duration_minutes ?? null,
      );
      const summary = s.title
        ? `${course?.name ?? "Curso"}: ${s.title}`
        : `${course?.name ?? "Curso"} — ${s.session_date}`;
      const description = `Sesión sincronizada desde ExamLab.\nCurso: ${course?.name ?? ""}`;

      if (provider === "microsoft") {
        // ── MICROSOFT GRAPH ──
        // Schema distinto a Google: `subject` no `summary`, `body`
        // con `{contentType, content}` no `description`. timeZone va
        // explícito por campo (Graph es estricto). attendees con
        // `emailAddress.address`. isOnlineMeeting+onlineMeetingProvider
        // dispara auto-creación de meeting de Teams — si la cuenta no
        // tiene licencia Teams o el tenant lo bloquea, el evento se
        // crea sin link de Teams (no falla; el docente puede pegar
        // uno manual en meeting_url).
        const eventBody = {
          subject: summary,
          body: { contentType: "Text", content: description },
          start: { dateTime: start.replace("Z", ""), timeZone: "America/Bogota" },
          end: { dateTime: end.replace("Z", ""), timeZone: "America/Bogota" },
          attendees: msAttendees,
          isOnlineMeeting: true,
          onlineMeetingProvider: "teamsForBusiness",
          // hideAttendees=false (default): los attendees ven a los otros.
          // Si querés ocultarlos, set `isHideAttendees: true` (Graph beta).
        };
        const extractTeamsLink = (ev: MsEvent): string | null =>
          ev.onlineMeeting?.joinUrl ?? null;
        const insertMsEvent = async (): Promise<MsEvent> => {
          return await callMicrosoft<MsEvent>(
            userId,
            `/me/calendars/${calId}/events`,
            { method: "POST", body: JSON.stringify(eventBody) },
          );
        };

        if (s.google_event_id) {
          let ev: MsEvent | null = null;
          let recreatedFromGone = false;
          try {
            ev = await callMicrosoft<MsEvent>(
              userId,
              `/me/events/${encodeURIComponent(s.google_event_id)}`,
              { method: "PATCH", body: JSON.stringify(eventBody) },
            );
          } catch (e) {
            if (isMicrosoftEventGoneError(e)) {
              recreatedFromGone = true;
            } else {
              throw e;
            }
          }
          if (recreatedFromGone) {
            ev = await insertMsEvent();
            const teamsLink = extractTeamsLink(ev);
            await adminClient
              .from("attendance_sessions")
              .update({ google_event_id: ev.id, meeting_url: teamsLink })
              .eq("id", s.id);
            created++;
          } else if (ev) {
            const teamsLink = extractTeamsLink(ev);
            if (teamsLink) {
              await adminClient
                .from("attendance_sessions")
                .update({ meeting_url: teamsLink })
                .eq("id", s.id);
            }
            updated++;
          }
        } else {
          const ev = await insertMsEvent();
          const teamsLink = extractTeamsLink(ev);
          await adminClient
            .from("attendance_sessions")
            .update({ google_event_id: ev.id, meeting_url: teamsLink })
            .eq("id", s.id);
          created++;
        }
        continue;
      }

      // ── GOOGLE CALENDAR ──
      const eventBody = {
        summary,
        description,
        start: { dateTime: start, timeZone: "America/Bogota" },
        end: { dateTime: end, timeZone: "America/Bogota" },
        attendees: googleAttendees,
        guestsCanSeeOtherGuests: false,
        reminders: { useDefault: true },
      };

      // Recreación si PATCH devuelve 404: el evento puede haber sido
      // borrado manualmente en Google Calendar (o quedó stale tras
      // mover el curso a otro calendario). En vez de marcar la sesión
      // como "fallida" para siempre, recreamos el evento y refrescamos
      // `google_event_id` en la fila. El docente solo ve "Creadas: N".
      const insertNewEvent = async (): Promise<GCalEvent> => {
        return await callGoogle<GCalEvent>(
          userId,
          `/calendar/v3/calendars/${calId}/events?conferenceDataVersion=1&sendUpdates=all`,
          {
            method: "POST",
            body: JSON.stringify({
              ...eventBody,
              conferenceData: {
                createRequest: {
                  requestId: `examlab-${s.id}-${Date.now()}`,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }),
          },
        );
      };
      const extractMeetLink = (ev: GCalEvent) =>
        ev.hangoutLink ||
        ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
        null;

      if (s.google_event_id) {
        // PATCH idempotente. Conservamos el Meet existente (no se
        // recrea) cuando el evento aún vive en Google. Si Google
        // responde 404, el event_id quedó stale → caemos a INSERT.
        let ev: GCalEvent | null = null;
        let recreatedFrom404 = false;
        try {
          ev = await callGoogle<GCalEvent>(
            userId,
            `/calendar/v3/calendars/${calId}/events/${encodeURIComponent(s.google_event_id)}?sendUpdates=all&conferenceDataVersion=1`,
            { method: "PATCH", body: JSON.stringify(eventBody) },
          );
        } catch (e) {
          // `callGoogle` lanza `GoogleApiError` con `.status` numérico
          // accesible. Antes detectábamos 404 con regex sobre el mensaje
          // (`[404]`), pero eso es frágil: si cambia el formato del
          // string (traducción, refactor), el catch deja de funcionar.
          // `isGoogleEventGoneError` lo encapsula y cubre 404 + 410.
          if (isGoogleEventGoneError(e)) {
            recreatedFrom404 = true;
          } else {
            throw e;
          }
        }
        if (recreatedFrom404) {
          ev = await insertNewEvent();
          const meetLink = extractMeetLink(ev);
          await adminClient
            .from("attendance_sessions")
            .update({ google_event_id: ev.id, meeting_url: meetLink })
            .eq("id", s.id);
          // Lo contamos como creado: para el docente, el evento es
          // efectivamente nuevo (id distinto, posiblemente Meet nuevo).
          created++;
        } else if (ev) {
          const meetLink = extractMeetLink(ev);
          // Solo actualizamos meeting_url si Google devolvió uno — si
          // el evento no tiene Meet asociado, dejamos lo que hubiera
          // en la fila (puede ser un link manual de Teams/Zoom).
          if (meetLink) {
            await adminClient
              .from("attendance_sessions")
              .update({ meeting_url: meetLink })
              .eq("id", s.id);
          }
          updated++;
        }
      } else {
        // INSERT con conferenceData → genera link de Meet.
        const ev = await insertNewEvent();
        const meetLink = extractMeetLink(ev);
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
      provider,
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

// ────────── Sync encuesta de CUPO → calendario ──────────
// Crea/actualiza UN evento por estudiante matriculado en los cursos de la
// encuesta de cupo, con el docente como invitado. Idempotente: la tabla
// `poll_calendar_events` mapea (poll_id, user_id) → event_id del proveedor,
// así re-sincronizar PATCHea el evento existente en vez de duplicar.
//
// Fecha/hora del evento (decisión documentada en la migración
// 20260943000000): los labels de los slots NO traen el año → parsearlos a
// timestamp exacto es ambiguo/frágil. Usamos `polls.closes_at` como ancla
// para todos los estudiantes; si es NULL caemos a NOW() + 7 días. Duración
// 90 min, zona America/Bogota. El evento es un recordatorio del cierre /
// sustentación de la cupo.
async function handleSyncPollToCalendar(
  userId: string,
  body: SyncPollToCalendarBody,
  // El provider del body es solo un hint (la UI de Encuestas no lo conoce);
  // el handler deriva `effectiveProvider` de la conexión del docente.
  _provider: Provider,
) {
  if (!body.pollId) return jsonError("poll_required", 400);

  // 1) Cargar la encuesta + validar que es de CUPO (slot).
  const { data: poll } = await adminClient
    .from("polls")
    .select("id, title, poll_type, closes_at, course_id, deleted_at")
    .eq("id", body.pollId)
    .maybeSingle();
  // Papelera: una encuesta soft-deleted NO debe ser sincronizable al
  // calendario externo de los alumnos. Se trata como inexistente.
  if (!poll || poll.deleted_at) return jsonError("poll_not_found", 404);
  if (poll.poll_type !== "slot") return jsonError("poll_not_slot", 400);

  // 2) Cursos de la encuesta (junction multi-curso). Siempre incluye el
  //    curso ancla tras el backfill de poll_courses.
  const { data: pollCourses } = await adminClient
    .from("poll_courses")
    .select("course_id")
    .eq("poll_id", body.pollId);
  const courseIds = (pollCourses ?? [])
    .map((c: { course_id: string }) => c.course_id)
    .filter((id: string) => !!id);
  // Fallback defensivo: si la junction estuviera vacía, usar el curso ancla.
  if (courseIds.length === 0 && poll.course_id) courseIds.push(poll.course_id);
  if (courseIds.length === 0) return jsonError("poll_has_no_courses", 400);

  // 3) Validar que el caller es docente de ALGUNO de los cursos de la
  //    encuesta (mismo criterio de WRITE que poll_courses: docente del
  //    curso ancla / cualquier curso linkeado).
  const { data: ct } = await adminClient
    .from("course_teachers")
    .select("course_id")
    .eq("user_id", userId)
    .in("course_id", courseIds)
    .limit(1);
  if (!ct || ct.length === 0) return jsonError("not_teacher_of_course", 403);

  // 4) Conexión + calendario. A diferencia de `handleSync` (que recibe el
  //    provider desde la UI del módulo Calendario), la UI de Encuestas NO
  //    conoce a qué proveedor está conectado el docente — así que DERIVAMOS
  //    el provider efectivo de la fila de tokens (ignoramos el hint del body).
  const { data: tok } = await adminClient
    .from("teacher_google_tokens")
    .select("calendar_id, provider, provider_email, google_email")
    .eq("teacher_id", userId)
    .maybeSingle();
  if (!tok?.calendar_id) return jsonError("no_calendar_selected", 400);
  const effectiveProvider: Provider = tok.provider === "microsoft" ? "microsoft" : "google";
  const calId = encodeURIComponent(tok.calendar_id);
  const teacherEmail = tok.provider_email ?? tok.google_email ?? null;

  // Pre-check: ¿existe todavía el calendario? (mismo patrón que handleSync)
  try {
    if (effectiveProvider === "microsoft") {
      await callMicrosoft<{ id: string }>(userId, `/me/calendars/${calId}`, { method: "GET" });
    } else {
      await callGoogle<{ id: string }>(userId, `/calendar/v3/calendars/${calId}`, {
        method: "GET",
      });
    }
  } catch (e) {
    const isGone =
      effectiveProvider === "microsoft" ? isMicrosoftEventGoneError(e) : isGoogleEventGoneError(e);
    if (isGone) {
      await adminClient
        .from("teacher_google_tokens")
        .update({ calendar_id: null, calendar_name: null })
        .eq("teacher_id", userId);
      await audit(userId, "calendar.calendar_missing", "warning", {
        provider: effectiveProvider,
        poll_id: body.pollId,
        calendar_id: tok.calendar_id,
      });
      return jsonError("calendar_not_accessible", 410);
    }
    throw e;
  }

  // 5) Curso (para el nombre) + matriculados DISTINCT a través de todos los
  //    cursos de la encuesta + registro de sincronización previo.
  const [{ data: course }, { data: enrolls }, { data: existing }] = await Promise.all([
    adminClient.from("courses").select("name").eq("id", courseIds[0]).maybeSingle(),
    adminClient.from("course_enrollments").select("user_id").in("course_id", courseIds),
    adminClient
      .from("poll_calendar_events")
      .select("user_id, event_id")
      .eq("poll_id", body.pollId),
  ]);

  const studentIds = Array.from(
    new Set((enrolls ?? []).map((e: { user_id: string }) => e.user_id)),
  );
  if (studentIds.length === 0) {
    return jsonOk({ created: 0, updated: 0, failed: 0, total: 0, errors: [] });
  }

  // Emails por estudiante (para el attendee de SU evento).
  const { data: profs } = await adminClient
    .from("profiles")
    .select("id, institutional_email")
    .in("id", studentIds);
  const emailByUser = new Map<string, string>();
  for (const p of (profs ?? []) as Array<{ id: string; institutional_email: string | null }>) {
    if (p.institutional_email && p.institutional_email.includes("@")) {
      emailByUser.set(p.id, p.institutional_email);
    }
  }

  // event_id ya sincronizado por estudiante (idempotencia).
  const eventIdByUser = new Map<string, string>();
  for (const r of (existing ?? []) as Array<{ user_id: string; event_id: string }>) {
    eventIdByUser.set(r.user_id, r.event_id);
  }

  // Fecha/hora ancla — ver decisión documentada arriba.
  const anchorDate = poll.closes_at
    ? new Date(poll.closes_at)
    : new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const start = anchorDate.toISOString();
  const end = new Date(anchorDate.getTime() + 90 * 60_000).toISOString();

  const courseName = course?.name ?? "Curso";
  const summary = `${courseName} - ${poll.title ?? "Encuesta"}`;
  const description =
    `Encuesta de cupo sincronizada desde ExamLab.\n` +
    `Curso: ${courseName}\nEncuesta: ${poll.title ?? ""}`;

  let created = 0,
    updated = 0,
    failed = 0;
  const errors: string[] = [];

  for (const studentId of studentIds) {
    const studentEmail = emailByUser.get(studentId);
    try {
      // Attendees: el estudiante + el docente. Si falta el email del
      // estudiante, el evento igual se crea (sin attendee de alumno) —
      // queda en el calendario del docente como recordatorio.
      const emails = [studentEmail, teacherEmail].filter(
        (e): e is string => !!e && e.includes("@"),
      );

      const existingEventId = eventIdByUser.get(studentId);

      if (effectiveProvider === "microsoft") {
        const msAttendees = emails.map((email) => ({
          emailAddress: { address: email, name: email.split("@")[0] },
          type: "required" as const,
        }));
        const eventBody = {
          subject: summary,
          body: { contentType: "Text", content: description },
          start: { dateTime: start.replace("Z", ""), timeZone: "America/Bogota" },
          end: { dateTime: end.replace("Z", ""), timeZone: "America/Bogota" },
          attendees: msAttendees,
        };
        const insertEvent = async (): Promise<MsEvent> =>
          await callMicrosoft<MsEvent>(userId, `/me/calendars/${calId}/events`, {
            method: "POST",
            body: JSON.stringify(eventBody),
          });

        if (existingEventId) {
          let recreated = false;
          let ev: MsEvent | null = null;
          try {
            ev = await callMicrosoft<MsEvent>(
              userId,
              `/me/events/${encodeURIComponent(existingEventId)}`,
              { method: "PATCH", body: JSON.stringify(eventBody) },
            );
          } catch (e) {
            if (isMicrosoftEventGoneError(e)) recreated = true;
            else throw e;
          }
          if (recreated) {
            ev = await insertEvent();
            await upsertPollCalendarEvent(body.pollId, studentId, effectiveProvider, ev.id);
            created++;
          } else {
            updated++;
          }
        } else {
          const ev = await insertEvent();
          await upsertPollCalendarEvent(body.pollId, studentId, effectiveProvider, ev.id);
          created++;
        }
        continue;
      }

      // ── GOOGLE ──
      const googleAttendees = emails.map((email) => ({
        email,
        responseStatus: "accepted" as const,
      }));
      const eventBody = {
        summary,
        description,
        start: { dateTime: start, timeZone: "America/Bogota" },
        end: { dateTime: end, timeZone: "America/Bogota" },
        attendees: googleAttendees,
        guestsCanSeeOtherGuests: false,
        reminders: { useDefault: true },
      };
      const insertEvent = async (): Promise<GCalEvent> =>
        await callGoogle<GCalEvent>(
          userId,
          `/calendar/v3/calendars/${calId}/events?sendUpdates=all`,
          { method: "POST", body: JSON.stringify(eventBody) },
        );

      if (existingEventId) {
        let recreated = false;
        let ev: GCalEvent | null = null;
        try {
          ev = await callGoogle<GCalEvent>(
            userId,
            `/calendar/v3/calendars/${calId}/events/${encodeURIComponent(existingEventId)}?sendUpdates=all`,
            { method: "PATCH", body: JSON.stringify(eventBody) },
          );
        } catch (e) {
          if (isGoogleEventGoneError(e)) recreated = true;
          else throw e;
        }
        if (recreated) {
          ev = await insertEvent();
          await upsertPollCalendarEvent(body.pollId, studentId, effectiveProvider, ev.id);
          created++;
        } else {
          updated++;
        }
      } else {
        const ev = await insertEvent();
        await upsertPollCalendarEvent(body.pollId, studentId, effectiveProvider, ev.id);
        created++;
      }
    } catch (e) {
      failed++;
      errors.push(`${studentEmail ?? studentId}: ${(e as Error).message}`);
    }
  }

  await audit(
    userId,
    failed > 0 && created + updated === 0 ? "calendar.poll_sync_failed" : "calendar.poll_synced",
    failed > 0 && created + updated === 0 ? "error" : "info",
    {
      provider: effectiveProvider,
      poll_id: body.pollId,
      poll_title: poll.title ?? null,
      course_ids: courseIds,
      calendar_id: tok.calendar_id,
      created,
      updated,
      failed,
      total: studentIds.length,
      first_errors: errors.slice(0, 3),
    },
    summary,
  );

  return jsonOk({ created, updated, failed, total: studentIds.length, errors });
}

/** UPSERT idempotente de la fila de sincronización (poll, estudiante) →
 *  event_id. onConflict en el UNIQUE (poll_id, user_id): re-sync actualiza
 *  el event_id + updated_at en vez de duplicar. */
async function upsertPollCalendarEvent(
  pollId: string,
  userId: string,
  provider: Provider,
  eventId: string,
) {
  await adminClient.from("poll_calendar_events").upsert(
    {
      poll_id: pollId,
      user_id: userId,
      provider,
      event_id: eventId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "poll_id,user_id" },
  );
}

// ────────── Reverse sync: Google Calendar → ExamLab ──────────
// Caso de uso: el docente ya tiene los eventos del semestre creados en
// Google Calendar (con sus links de Meet/Zoom). En ExamLab tiene las N
// sesiones armadas pero sin meeting_url. En vez de copiar/pegar links
// uno por uno, abre el dialog "Vincular desde calendario", lista los
// eventos de Google en una ventana de tiempo, y asocia uno-a-uno.

/** Tipo subset del evento de Google Calendar API v3. Solo los campos
 *  que necesitamos para mostrar al docente + persistir. */
interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  hangoutLink?: string;
  htmlLink?: string;
  status?: string;
  /** Adjuntos del evento. Google Meet agrega la grabación (video en Drive)
   *  como attachment una vez procesada tras la reunión. */
  attachments?: Array<{ fileUrl?: string; title?: string; mimeType?: string }>;
}

/** Extrae el link de la GRABACIÓN de un evento de Google Calendar. Google
 *  Meet adjunta la grabación (video de Drive) como `attachments` del evento
 *  cuando la reunión fue grabada y procesada. Heurística: primer adjunto que
 *  sea video (mimeType `video/*` o el tipo nativo de Drive) o cuyo título
 *  sugiera grabación. Devuelve null si el evento aún no tiene grabación. */
function extractGoogleRecordingUrl(ev: GoogleEvent): string | null {
  const atts = ev.attachments ?? [];
  const match = atts.find((a) => {
    const mt = (a.mimeType ?? "").toLowerCase();
    const title = (a.title ?? "").toLowerCase();
    return (
      mt.startsWith("video/") ||
      mt === "application/vnd.google-apps.video" ||
      title.includes("grabaci") ||
      title.includes("recording")
    );
  });
  return match?.fileUrl ?? null;
}

/** Extrae el link a las NOTAS / minuta de un evento de Google Calendar.
 *  Cuando la reunión usó "tomar notas con Gemini", Google adjunta el
 *  documento generado (un Google Doc) como `attachments` del evento.
 *  Heurística: primer Google Doc cuyo título sugiera notas (nota/notes/
 *  recap/acta/minut). Si no hay match por título pero existe UN solo Google
 *  Doc en el evento, lo usamos (es casi seguro la minuta — los eventos no
 *  suelen llevar Docs sueltos). Devuelve null si el evento no tiene notas. */
function extractGoogleNotesUrl(ev: GoogleEvent): string | null {
  const docs = (ev.attachments ?? []).filter(
    (a) => (a.mimeType ?? "").toLowerCase() === "application/vnd.google-apps.document",
  );
  const titled = docs.find((a) => {
    const title = (a.title ?? "").toLowerCase();
    return (
      title.includes("nota") ||
      title.includes("notes") ||
      title.includes("recap") ||
      title.includes("acta") ||
      title.includes("minut")
    );
  });
  if (titled) return titled.fileUrl ?? null;
  // Sin match por título: si hay exactamente UN Google Doc, asumimos que es
  // la minuta. Con varios no adivinamos (podría ser material de clase).
  if (docs.length === 1) return docs[0].fileUrl ?? null;
  return null;
}

async function handleListEvents(userId: string, body: ListEventsBody, provider: Provider) {
  if (!body.fromDate || !body.toDate) return jsonError("date_range_required", 400);
  // Sanity check de formato (no consultamos al proveedor si los datos
  // son basura — el endpoint igual rechazaría con 400 pero el mensaje
  // no ayuda al docente).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(body.toDate)) {
    return jsonError("invalid_date_format", 400);
  }

  // Verificar conexión + calendario seleccionado + provider coincide.
  const { data: tok } = await adminClient
    .from("teacher_google_tokens")
    .select("calendar_id, provider")
    .eq("teacher_id", userId)
    .maybeSingle();
  if (!tok?.calendar_id) return jsonError("no_calendar_selected", 400);
  if ((tok.provider ?? "google") !== provider) return jsonError("provider_mismatch", 409);
  const calId = encodeURIComponent(tok.calendar_id);

  if (provider === "microsoft") {
    // Graph: `calendarView` expande recurrentes (paralelo a Google
    // `singleEvents=true`). startDateTime/endDateTime van en ISO UTC
    // sin offset; Graph asume UTC salvo header `Prefer: outlook.timezone`.
    const url =
      `/me/calendars/${calId}/calendarView` +
      `?startDateTime=${encodeURIComponent(`${body.fromDate}T00:00:00`)}` +
      `&endDateTime=${encodeURIComponent(`${body.toDate}T23:59:59`)}` +
      `&$top=250&$orderby=start/dateTime` +
      `&$select=id,subject,bodyPreview,webLink,onlineMeeting,start,end,isCancelled`;
    try {
      const res = await callMicrosoft<{ value?: MsEvent[] }>(userId, url, {
        method: "GET",
        headers: { Prefer: 'outlook.timezone="America/Bogota"' },
      });
      const items = (res.value ?? [])
        .filter((e) => e.isCancelled !== true)
        .map((e) => ({
          id: e.id,
          summary: e.subject ?? "(sin título)",
          description: e.bodyPreview ?? null,
          start: e.start?.dateTime ?? null,
          end: e.end?.dateTime ?? null,
          hangoutLink: e.onlineMeeting?.joinUrl ?? null,
          htmlLink: e.webLink ?? null,
          // Microsoft no expone la grabación de Teams en el evento (vive en
          // Graph onlineMeetings/recordings, otra API) → null por ahora.
          recordingUrl: null,
          // Graph no expone las notas de la reunión en el evento → null.
          notesUrl: null,
        }));
      return jsonOk({ events: items });
    } catch (e) {
      if (isMicrosoftEventGoneError(e)) {
        return jsonError("calendar_not_accessible", 410);
      }
      return jsonError(`microsoft_api_error: ${(e as Error).message}`, 502);
    }
  }

  // Google Calendar API espera RFC3339 con offset. Usamos -05:00
  // (Bogotá) como en handleSync. fromDate=00:00, toDate=23:59:59.
  const timeMin = `${body.fromDate}T00:00:00-05:00`;
  const timeMax = `${body.toDate}T23:59:59-05:00`;
  const url =
    `/calendar/v3/calendars/${calId}/events` +
    `?timeMin=${encodeURIComponent(timeMin)}` +
    `&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true` + // expandir recurrentes a instancias
    `&orderBy=startTime` +
    `&maxResults=250`;

  try {
    const res = await callGoogle<{ items?: GoogleEvent[] }>(userId, url, { method: "GET" });
    const items = (res.items ?? [])
      // Filtrar los cancelados — Google los devuelve igual con
      // status="cancelled" cuando se borraron de una serie recurrente.
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        id: e.id,
        summary: e.summary ?? "(sin título)",
        description: e.description ?? null,
        start: e.start?.dateTime ?? e.start?.date ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        hangoutLink: e.hangoutLink ?? null,
        htmlLink: e.htmlLink ?? null,
        // Grabación de Meet (si el evento ya la tiene adjunta en Drive).
        recordingUrl: extractGoogleRecordingUrl(e),
        // Notas / minuta (Google Doc de Gemini adjunto al evento, si existe).
        notesUrl: extractGoogleNotesUrl(e),
      }));
    return jsonOk({ events: items });
  } catch (e) {
    if (isGoogleEventGoneError(e)) {
      return jsonError("calendar_not_accessible", 410);
    }
    return jsonError(`google_api_error: ${(e as Error).message}`, 502);
  }
}

/**
 * Tarea programada: re-sincroniza, para CADA docente con calendario
 * conectado, las sesiones que ya quedaron vinculadas a un evento
 * (`google_event_id` set). Re-fetch del evento → actualiza recording_url /
 * notes_url / meeting_url SI el evento ahora los tiene (no pisa con null lo
 * que se cargó manualmente). Así las grabaciones que Meet/Calendar adjuntan
 * tras la clase aparecen solas en el tablero, sin que el docente entre a
 * "Vincular eventos".
 *
 * Acotado a sesiones recientes (últimos 45 días) y a un tope de eventos por
 * corrida para no exceder el timeout del edge ni golpear rate limits de la
 * API. Errores por docente/sesión (token revocado, evento borrado) se cuentan
 * y se sigue — una cuenta caída no aborta el resto.
 */
const CRON_MAX_EVENTS = 600;
async function handleCronSyncRecordings() {
  const sinceIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: tokens } = await adminClient
    .from("teacher_google_tokens")
    .select("teacher_id, calendar_id, provider")
    .not("calendar_id", "is", null);

  let teachers = 0;
  let checked = 0;
  let updated = 0;
  let failed = 0;

  for (const tok of (tokens ?? []) as Array<{
    teacher_id: string;
    calendar_id: string;
    provider: string | null;
  }>) {
    if (checked >= CRON_MAX_EVENTS) break;
    teachers += 1;
    const prov: Provider = (tok.provider ?? "google") === "microsoft" ? "microsoft" : "google";
    try {
      const { data: cts } = await adminClient
        .from("course_teachers")
        .select("course_id")
        .eq("user_id", tok.teacher_id);
      const courseIds = (cts ?? []).map((c: { course_id: string }) => c.course_id);
      if (courseIds.length === 0) continue;

      const { data: sessions } = await adminClient
        .from("attendance_sessions")
        .select("id, google_event_id, recording_url, notes_url, meeting_url")
        .in("course_id", courseIds)
        .not("google_event_id", "is", null)
        .is("deleted_at", null)
        .gte("session_date", sinceIso);

      const calId = encodeURIComponent(tok.calendar_id);
      for (const s of (sessions ?? []) as Array<{
        id: string;
        google_event_id: string;
        recording_url: string | null;
        notes_url: string | null;
        meeting_url: string | null;
      }>) {
        if (checked >= CRON_MAX_EVENTS) break;
        checked += 1;
        try {
          let recordingUrl: string | null = null;
          let notesUrl: string | null = null;
          let meetingUrl: string | null = null;
          if (prov === "microsoft") {
            const ev = await callMicrosoft<MsEvent>(
              tok.teacher_id,
              `/me/events/${encodeURIComponent(s.google_event_id)}?$select=id,subject,webLink,onlineMeeting`,
              { method: "GET" },
            );
            meetingUrl = ev.onlineMeeting?.joinUrl ?? ev.webLink ?? null;
          } else {
            const ev = await callGoogle<GoogleEvent>(
              tok.teacher_id,
              `/calendar/v3/calendars/${calId}/events/${encodeURIComponent(s.google_event_id)}`,
              { method: "GET" },
            );
            meetingUrl = ev.hangoutLink ?? ev.htmlLink ?? null;
            recordingUrl = extractGoogleRecordingUrl(ev);
            notesUrl = extractGoogleNotesUrl(ev);
          }
          // Solo lo que el evento TIENE y que cambió — nunca pisar con null.
          const patch: Record<string, unknown> = {};
          if (recordingUrl && recordingUrl !== s.recording_url) patch.recording_url = recordingUrl;
          if (notesUrl && notesUrl !== s.notes_url) patch.notes_url = notesUrl;
          if (meetingUrl && meetingUrl !== s.meeting_url) patch.meeting_url = meetingUrl;
          if (Object.keys(patch).length > 0) {
            await adminClient.from("attendance_sessions").update(patch).eq("id", s.id);
            updated += 1;
          }
        } catch (_) {
          failed += 1;
        }
      }
    } catch (_) {
      failed += 1;
    }
  }

  // Audit best-effort (actor = sistema; el helper audit() exige userId real).
  try {
    await adminClient.from("audit_logs").insert({
      action: "calendar.cron_sync_recordings",
      category: "calendar",
      severity: "info",
      metadata: { teachers, checked, updated, failed },
    });
  } catch (_) {
    /* best-effort */
  }

  return jsonOk({ teachers, checked, updated, failed });
}

async function handleLinkEventsToSessions(
  userId: string,
  body: LinkEventsBody,
  provider: Provider,
) {
  if (!body.courseId) return jsonError("course_required", 400);
  if (!Array.isArray(body.links) || body.links.length === 0) {
    return jsonError("links_required", 400);
  }

  // 1) Validar docente del curso.
  const { data: ct } = await adminClient
    .from("course_teachers")
    .select("course_id")
    .eq("course_id", body.courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!ct) return jsonError("not_teacher_of_course", 403);

  // 2) Calendario seleccionado + provider coincide.
  const { data: tok } = await adminClient
    .from("teacher_google_tokens")
    .select("calendar_id, provider")
    .eq("teacher_id", userId)
    .maybeSingle();
  if (!tok?.calendar_id) return jsonError("no_calendar_selected", 400);
  if ((tok.provider ?? "google") !== provider) return jsonError("provider_mismatch", 409);
  const calId = encodeURIComponent(tok.calendar_id);

  // 3) Pre-validación: todas las sesiones deben ser del curso del
  //    docente. Filtro silenciosamente las que no — defensa contra
  //    bugs de UI que mandarían sesiones de otros cursos.
  const sessionIds = body.links.map((l) => l.sessionId);
  const { data: validSessions } = await adminClient
    .from("attendance_sessions")
    .select("id")
    .eq("course_id", body.courseId)
    // Papelera: una sesión soft-deleted no debe poder re-vincularse a un
    // evento de calendario hasta que se restaure.
    .is("deleted_at", null)
    .in("id", sessionIds);
  const validIdSet = new Set(
    (validSessions ?? []).map((s: { id: string }) => s.id),
  );

  // 4) Procesar uno a uno. Para cada link válido:
  //    - Si eventId es null → desvincular (clear google_event_id +
  //      meeting_url).
  //    - Si eventId es string → fetchear el evento de Google para
  //      sacar hangoutLink (Meet URL); UPDATE en attendance_sessions.
  let linked = 0;
  let unlinked = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const link of body.links) {
    if (!validIdSet.has(link.sessionId)) {
      failed += 1;
      errors.push(`session_not_in_course: ${link.sessionId}`);
      continue;
    }
    try {
      if (link.eventId === null) {
        // Desvincular.
        await adminClient
          .from("attendance_sessions")
          .update({ google_event_id: null, meeting_url: null })
          .eq("id", link.sessionId);
        unlinked += 1;
        continue;
      }
      // Fetch del evento para extraer meeting_url. Distinto path por
      // provider: Google `/calendars/{id}/events/{id}`, Microsoft
      // `/me/events/{id}` (cualquier calendario del usuario).
      let eventId: string;
      let meetingUrl: string | null;
      // Grabación y notas: solo Google las expone en el evento (attachments
      // de Drive). Microsoft no.
      let recordingUrl: string | null = null;
      let notesUrl: string | null = null;
      if (provider === "microsoft") {
        const ev = await callMicrosoft<MsEvent>(
          userId,
          `/me/events/${encodeURIComponent(link.eventId)}?$select=id,subject,webLink,onlineMeeting`,
          { method: "GET" },
        );
        eventId = ev.id;
        meetingUrl = ev.onlineMeeting?.joinUrl ?? ev.webLink ?? null;
      } else {
        const ev = await callGoogle<GoogleEvent>(
          userId,
          `/calendar/v3/calendars/${calId}/events/${encodeURIComponent(link.eventId)}`,
          { method: "GET" },
        );
        eventId = ev.id;
        meetingUrl = ev.hangoutLink ?? ev.htmlLink ?? null;
        recordingUrl = extractGoogleRecordingUrl(ev);
        notesUrl = extractGoogleNotesUrl(ev);
      }
      // recording_url / notes_url solo se setean si el evento los TIENE —
      // así no pisamos con null un enlace cargado manualmente en la sesión.
      const updatePayload: Record<string, unknown> = {
        google_event_id: eventId,
        meeting_url: meetingUrl,
      };
      if (recordingUrl) updatePayload.recording_url = recordingUrl;
      if (notesUrl) updatePayload.notes_url = notesUrl;
      await adminClient
        .from("attendance_sessions")
        .update(updatePayload)
        .eq("id", link.sessionId);
      linked += 1;
    } catch (e) {
      failed += 1;
      errors.push(`${link.sessionId}: ${(e as Error).message}`);
    }
  }

  await audit(userId, "calendar.events_linked_to_sessions", "info", {
    provider,
    course_id: body.courseId,
    linked,
    unlinked,
    failed,
  });

  return jsonOk({
    linked,
    unlinked,
    failed,
    total: body.links.length,
    errors: errors.slice(0, 20), // cap por si hay muchos
  });
}
