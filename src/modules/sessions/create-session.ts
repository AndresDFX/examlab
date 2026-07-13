/**
 * Modelo de campos UNIFICADO para crear una sesión (`attendance_sessions`).
 *
 * Los dos tableros que crean sesiones —el Tablero del curso
 * (`app.teacher.board.$courseId.tsx`) y Asistencia (`app.teacher.attendance.tsx`)—
 * armaban payloads de INSERT DIVERGENTES: el board incluía `meeting_url` +
 * duración directa + prefill de horario; Asistencia incluía `cut_id` +
 * `recording_video_id` + duración derivada de hora inicio/fin. Eso hacía que una
 * sesión creada en un lado no tuviera las mismas columnas que en el otro.
 *
 * `buildNewSessionPayload` centraliza el modelo de campos y la normalización de
 * `start_time`. Cada caller recolecta el subconjunto que su UI expone; los
 * campos NO provistos (`undefined`) se OMITEN del payload → aplica el default/
 * null de la DB (mismo comportamiento que cuando no estaban en el payload). Un
 * `null` EXPLÍCITO sí se incluye (limpia la columna).
 *
 * Pure — sin red, sin Date.now(). Testeable en aislamiento.
 */
export interface NewSessionFields {
  course_id: string;
  session_date: string; // DATE "YYYY-MM-DD"
  created_by: string;
  title?: string | null;
  /** "HH:MM" | "HH:MM:SS" | null — se normaliza a "HH:MM:SS" (TIME sin TZ). */
  start_time?: string | null;
  duration_minutes?: number | null;
  cut_id?: string | null;
  meeting_url?: string | null;
  recording_url?: string | null;
  recording_video_id?: string | null;
  notes_url?: string | null;
  content_id?: string | null;
  content_class_index?: number | null;
}

/** Normaliza `start_time` a "HH:MM:SS" (columna TIME sin zona horaria). Vacío/
 *  nulo → null. "HH:MM" → "HH:MM:00"; "HH:MM:SS" se deja igual. */
export function normalizeStartTime(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  return /^\d{1,2}:\d{2}$/.test(s) ? `${s}:00` : s;
}

/** Arma el payload de INSERT con el modelo de campos unificado. Solo incluye
 *  las columnas provistas (undefined → omitida). `course_id` / `session_date` /
 *  `created_by` son obligatorias. */
export function buildNewSessionPayload(f: NewSessionFields): Record<string, unknown> {
  const p: Record<string, unknown> = {
    course_id: f.course_id,
    session_date: f.session_date,
    created_by: f.created_by,
  };
  if (f.title !== undefined) p.title = f.title;
  if (f.start_time !== undefined) p.start_time = normalizeStartTime(f.start_time);
  if (f.duration_minutes !== undefined) p.duration_minutes = f.duration_minutes;
  if (f.cut_id !== undefined) p.cut_id = f.cut_id;
  if (f.meeting_url !== undefined) p.meeting_url = f.meeting_url;
  if (f.recording_url !== undefined) p.recording_url = f.recording_url;
  if (f.recording_video_id !== undefined) p.recording_video_id = f.recording_video_id;
  if (f.notes_url !== undefined) p.notes_url = f.notes_url;
  if (f.content_id !== undefined) p.content_id = f.content_id;
  if (f.content_class_index !== undefined) p.content_class_index = f.content_class_index;
  return p;
}
