/**
 * Helpers PUROS para el import/export CSV de attendance_sessions.
 *
 * Se extrajeron de `src/routes/app.teacher.attendance.tsx` para poder
 * testearlos sin montar el componente. La ruta importa estos helpers
 * y los compone con efectos de DB (`supabase.insert`, `loadCourse`,
 * `cuts`/`user`/`courseId` del contexto React).
 *
 * INVARIANTES (a mantener cuando se cambien estos helpers):
 *   - El header del template coincide con el orden de columnas que
 *     `buildSessionsCsv` emite (round-trip exacto).
 *   - `parseHHMMToMinutes` retorna null para inválidos (NO NaN) para
 *     que el caller distinga "ausente" de "mal formado" sin checks
 *     extra.
 *   - Cuando llega `end_time` SIN `start_time` el importer aborta la
 *     fila — "fin sin inicio" es dato inconsistente.
 *   - Cuando llega ambos y `end > start`, derivamos
 *     `duration_minutes = end - start`.
 *   - Si NO resuelve end-start (faltan, mal formados o end <= start)
 *     hacemos fallback a la columna legacy `duration_minutes` para no
 *     romper round-trip de exports viejos.
 */

/** Valores válidos de `session_type`. Fuente de verdad canónica en
 *  `src/modules/sessions/session-type.ts` (`SESSION_TYPES`); se inlinea acá
 *  para no acoplar este helper puro al módulo que importa iconos de lucide. */
const SESSION_TYPE_VALUES = ["presencial", "virtual", "autonoma"] as const;
const DEFAULT_SESSION_TYPE = "virtual";

/** Header + filas demo del template descargable. */
export const SESSIONS_TEMPLATE = `session_date,title,start_time,end_time,meeting_url,cut_name,recording_url,session_type
2026-06-14,Clase 1 — Introducción,18:00,20:00,https://meet.google.com/abc-defg-hij,Corte 1,,presencial
2026-06-16,Clase 2 — Variables y tipos,18:00,20:00,,Corte 1,,virtual
2026-06-21,Repaso autónomo,,,,,,autonoma`;

/** Orden estable de columnas que `buildSessionsCsv` emite. Debe
 *  coincidir con el header de `SESSIONS_TEMPLATE`. */
export const SESSIONS_CSV_COLUMNS = [
  "session_date",
  "title",
  "start_time",
  "end_time",
  "meeting_url",
  "cut_name",
  "recording_url",
  "session_type",
] as const;

/** Parsea HH:MM o HH:MM:SS a minutos del día (0..1439). Inválido → null. */
export function parseHHMMToMinutes(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Suma `minutes` a una HH:MM y devuelve HH:MM padded. Wraparound a 24h.
 *  HH:MM inválida → "". */
export function addMinutesToHHMM(hhmm: string, minutes: number): string {
  const base = parseHHMMToMinutes(hhmm);
  if (base == null) return "";
  const total = (((base + minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Sesión que sirve de entrada a `buildSessionsRows`. Subset del tipo
 *  `Session` de la ruta — solo lo que el CSV necesita. */
export interface SessionForCsv {
  session_date: string;
  title: string | null;
  start_time?: string | null;
  duration_minutes?: number | null;
  meeting_url?: string | null;
  cut_id?: string | null;
  recording_url?: string | null;
  session_type?: string | null;
}

/** Build de las filas (array de objetos) que `toCSV` serializa.
 *  Separado de `toCSV` para testear el shape sin mockear el serializer. */
export function buildSessionsRows(
  sessions: SessionForCsv[],
  cutNameById: Map<string, string>,
): Array<Record<string, string>> {
  return sessions.map((s) => {
    const startTimeShort = s.start_time ? String(s.start_time).slice(0, 5) : "";
    const endTimeShort =
      startTimeShort && s.duration_minutes != null
        ? addMinutesToHHMM(startTimeShort, s.duration_minutes)
        : "";
    return {
      session_date: s.session_date,
      title: s.title ?? "",
      start_time: startTimeShort,
      end_time: endTimeShort,
      meeting_url: s.meeting_url ?? "",
      cut_name: s.cut_id ? (cutNameById.get(s.cut_id) ?? "") : "",
      recording_url: s.recording_url ?? "",
      session_type: (SESSION_TYPE_VALUES as readonly string[]).includes(s.session_type ?? "")
        ? (s.session_type as string)
        : DEFAULT_SESSION_TYPE,
    };
  });
}

/** Payload normalizado de UNA fila lista para insertar en
 *  `attendance_sessions`. No incluye `course_id` ni `created_by` —
 *  esos los aporta el caller. */
export interface ParsedSessionRow {
  session_date: string;
  title: string | null;
  cut_id: string | null;
  start_time: string | null;
  duration_minutes: number | null;
  meeting_url: string | null;
  recording_url: string | null;
  session_type: string;
}

/** Resultado del parseo del CSV completo. `unmatchedCuts` cuenta filas
 *  con `cut_name` que no matchearon contra ningún corte conocido — el
 *  caller lo expone como suffix al toast de éxito. */
export interface ParseSessionsResult {
  rows: ParsedSessionRow[];
  unmatchedCuts: number;
}

/** Parsea las filas crudas del CSV (ya pasadas por `parseCSV` que
 *  devuelve `Record<string, string>` por fila) a payloads normalizados.
 *  Lanza `Error` con mensaje friendly + número de línea Excel-style
 *  (header = línea 1, primera fila de datos = línea 2). */
export function parseSessionsCsv(
  rows: Array<Record<string, string>>,
  cutByName: Map<string, string>,
): ParseSessionsResult {
  const out: ParsedSessionRow[] = [];
  let unmatched = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 2;
    const rawDate = (r.session_date || "").trim();
    if (!rawDate) {
      throw new Error(`Fila ${lineNo}: session_date es obligatorio.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      throw new Error(
        `Fila ${lineNo}: session_date "${rawDate}" no es una fecha válida (formato YYYY-MM-DD).`,
      );
    }

    const cutKey = (r.cut_name || "").trim().toLowerCase();
    const cutId = cutKey ? (cutByName.get(cutKey) ?? null) : null;
    if (cutKey && !cutId) unmatched++;

    const rawStart = (r.start_time || "").trim();
    const rawEnd = (r.end_time || "").trim();
    const startTime = /^\d{1,2}:\d{2}(:\d{2})?$/.test(rawStart) ? rawStart : null;

    if (rawEnd && !rawStart) {
      throw new Error(
        `Fila ${lineNo}: end_time sin start_time. Indica también la hora de inicio.`,
      );
    }

    const startMin = startTime ? parseHHMMToMinutes(startTime) : null;
    const endMin = parseHHMMToMinutes(rawEnd);
    let duration: number | null = null;
    if (startMin != null && endMin != null && endMin > startMin) {
      duration = endMin - startMin;
    } else {
      const rawDur = (r.duration_minutes || "").trim();
      const durNum = rawDur ? Number.parseInt(rawDur, 10) : NaN;
      duration = Number.isFinite(durNum) && durNum >= 0 ? durNum : null;
    }

    const rawType = (r.session_type || "").trim().toLowerCase();
    const sessionType = (SESSION_TYPE_VALUES as readonly string[]).includes(rawType)
      ? rawType
      : DEFAULT_SESSION_TYPE;

    out.push({
      session_date: rawDate,
      title: r.title ? r.title : null,
      cut_id: cutId,
      start_time: startTime,
      duration_minutes: duration,
      meeting_url: (r.meeting_url || "").trim() || null,
      recording_url: (r.recording_url || "").trim() || null,
      session_type: sessionType,
    });
  }

  return { rows: out, unmatchedCuts: unmatched };
}
